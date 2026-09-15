import { describe, expect, it } from 'vitest';
import {
  REPORT_DIMENSION,
  REPORT_MEASURE,
  type ReportDimension,
  type ReportMeasure,
} from '../../src/reports/report.port.js';
import {
  buildReportGrid,
  type ReportEngineInput,
  type ReportSourceRow,
} from '../../src/reports/report-engine.js';

function createRow(overrides: Partial<ReportSourceRow> = {}): ReportSourceRow {
  return {
    transactionId: overrides.transactionId ?? 'tx-001',
    occurredAt: overrides.occurredAt ?? new Date('2026-01-15T12:00:00.000Z'),
    type: overrides.type ?? 'expense',
    status: overrides.status ?? 'posted',
    amountMinor: overrides.amountMinor ?? 1000n,
    currency: overrides.currency ?? 'USD',
    convertedMinor: overrides.convertedMinor ?? 1000n,
    accountId: overrides.accountId ?? 'acc-001',
    accountType: overrides.accountType ?? 'checking',
    categoryId:
      'categoryId' in overrides ? (overrides.categoryId ?? null) : 'cat-001',
    tags: overrides.tags ?? ['general'],
    payee: 'payee' in overrides ? (overrides.payee ?? null) : 'Merchant A',
    memberId: overrides.memberId ?? 'mem-001',
    variability:
      'variability' in overrides ? (overrides.variability ?? null) : 'fixed',
  };
}

describe('Report Engine (pure)', () => {
  describe('Mutation-proof behaviors', () => {
    it('formats int64-scale variation without losing BigInt precision', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-10T00:00:00.000Z'),
          convertedMinor: 1n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          convertedMinor: 9223372036854775807n,
        }),
      ];

      const grid = buildReportGrid({
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.VARIATION],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      });

      expect(grid.rows[1].cells[0]).toEqual({
        measure: REPORT_MEASURE.VARIATION,
        value: '922337203685477580600.00',
      });
    });

    it('formats negative int64-scale variation exactly', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-10T00:00:00.000Z'),
          convertedMinor: 9223372036854775807n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          convertedMinor: -9223372036854775807n,
        }),
      ];

      const grid = buildReportGrid({
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.VARIATION],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      });

      expect(grid.rows[1].cells[0]).toEqual({
        measure: REPORT_MEASURE.VARIATION,
        value: '-200.00',
      });
    });

    it('rounds an exact half tie away from zero for variation', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-10T00:00:00.000Z'),
          convertedMinor: 20000n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          convertedMinor: 20001n,
        }),
      ];

      const grid = buildReportGrid({
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.VARIATION],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      });

      expect(grid.rows[1].cells[0]).toEqual({
        measure: REPORT_MEASURE.VARIATION,
        value: '0.01',
      });
    });

    it('tag fan-out counts row once per tag into separate buckets and totals exceed grand total', () => {
      const row = createRow({
        convertedMinor: 1000n,
        tags: ['groceries', 'household'],
      });
      const input: ReportEngineInput = {
        rows: [row],
        dimensions: [REPORT_DIMENSION.TAG],
        measures: [REPORT_MEASURE.CONVERTED_VALUE, REPORT_MEASURE.COUNT],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(2);
      expect(grid.rows[0].key).toEqual(['groceries']);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '1000' },
        { measure: REPORT_MEASURE.COUNT, value: '1' },
      ]);
      expect(grid.rows[1].key).toEqual(['household']);
      expect(grid.rows[1].cells).toEqual([
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '1000' },
        { measure: REPORT_MEASURE.COUNT, value: '1' },
      ]);

      // Measure sum across tag buckets is 2000n, exceeding the 1000n transaction grand total
      const totalAcrossBuckets = grid.rows.reduce(
        (acc, r) => acc + BigInt(r.cells[0].value!),
        0n,
      );
      expect(totalAcrossBuckets).toBe(2000n);
    });

    it('tag warning is included whenever tag is in dimensions', () => {
      const input: ReportEngineInput = {
        rows: [createRow({ tags: ['urgent'] })],
        dimensions: [REPORT_DIMENSION.TAG],
        measures: [REPORT_MEASURE.COUNT],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.warnings).toContain(
        'Rows are counted once per tag; totals across tag buckets may exceed the grand total.',
      );
    });

    it('sum returns null for mixed-currency bucket while converted_value returns sum S', () => {
      const rows = [
        createRow({
          accountId: 'acc-1',
          currency: 'USD',
          amountMinor: 1000n,
          convertedMinor: 1000n,
        }),
        createRow({
          accountId: 'acc-1',
          currency: 'EUR',
          amountMinor: 900n,
          convertedMinor: 1000n,
        }),
      ];
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.ACCOUNT],
        measures: [REPORT_MEASURE.SUM, REPORT_MEASURE.CONVERTED_VALUE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(1);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.SUM, value: null },
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '2000' },
      ]);
    });

    it('mixed-currency warning is included when a bucket mixes currencies', () => {
      const rows = [
        createRow({ currency: 'USD', amountMinor: 100n, convertedMinor: 100n }),
        createRow({
          currency: 'COP',
          amountMinor: 400000n,
          convertedMinor: 100n,
        }),
      ];
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.STATUS],
        measures: [REPORT_MEASURE.SUM],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.warnings).toContain(
        'Native sum is undefined for buckets mixing currencies; use converted_value.',
      );
    });

    it('category dimension retains null categoryId rows into uncategorized bucket instead of dropping them', () => {
      const row = createRow({
        categoryId: null,
        convertedMinor: 500n,
      });
      const input: ReportEngineInput = {
        rows: [row],
        dimensions: [REPORT_DIMENSION.CATEGORY],
        measures: [REPORT_MEASURE.CONVERTED_VALUE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(1);
      expect(grid.rows[0].key).toEqual(['uncategorized']);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '500' },
      ]);
    });

    it('payee dimension retains null payee rows into unknown bucket instead of dropping them', () => {
      const row = createRow({
        payee: null,
        convertedMinor: 600n,
      });
      const input: ReportEngineInput = {
        rows: [row],
        dimensions: [REPORT_DIMENSION.PAYEE],
        measures: [REPORT_MEASURE.CONVERTED_VALUE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(1);
      expect(grid.rows[0].key).toEqual(['unknown']);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '600' },
      ]);
    });

    it('variability dimension retains null variability rows into unspecified bucket instead of dropping them', () => {
      const row = createRow({
        variability: null,
        convertedMinor: 700n,
      });
      const input: ReportEngineInput = {
        rows: [row],
        dimensions: [REPORT_DIMENSION.VARIABILITY],
        measures: [REPORT_MEASURE.CONVERTED_VALUE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(1);
      expect(grid.rows[0].key).toEqual(['unspecified']);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '700' },
      ]);
    });

    it('percentage returns null when grand total of S across all buckets is zero', () => {
      const rows = [
        createRow({
          accountId: 'acc-1',
          convertedMinor: 1000n,
        }),
        createRow({
          accountId: 'acc-2',
          convertedMinor: -1000n,
        }),
      ];
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.ACCOUNT],
        measures: [REPORT_MEASURE.PERCENTAGE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(2);
      expect(grid.rows[0].cells[0]).toEqual({
        measure: REPORT_MEASURE.PERCENTAGE,
        value: null,
      });
      expect(grid.rows[1].cells[0]).toEqual({
        measure: REPORT_MEASURE.PERCENTAGE,
        value: null,
      });
    });

    it('balance returns running cumulative S over emitted bucket order rather than bucket S', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-10T00:00:00.000Z'),
          convertedMinor: 100n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          convertedMinor: 200n,
        }),
        createRow({
          occurredAt: new Date('2026-03-10T00:00:00.000Z'),
          convertedMinor: 300n,
        }),
      ];
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.BALANCE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(3);
      expect(grid.rows[0].cells[0].value).toBe('100');
      expect(grid.rows[1].cells[0].value).toBe('300');
      expect(grid.rows[2].cells[0].value).toBe('600');
    });

    it('variation returns null for the first bucket in emitted order rather than 0.00', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-10T00:00:00.000Z'),
          convertedMinor: 100n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          convertedMinor: 150n,
        }),
      ];
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.VARIATION],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(2);
      expect(grid.rows[0].cells[0]).toEqual({
        measure: REPORT_MEASURE.VARIATION,
        value: null,
      });
      expect(grid.rows[1].cells[0]).toEqual({
        measure: REPORT_MEASURE.VARIATION,
        value: '50.00',
      });
    });

    it('moving_average requires a window of 3 buckets and returns null when fewer than 3 are available', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-10T00:00:00.000Z'),
          convertedMinor: 100n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          convertedMinor: 200n,
        }),
        createRow({
          occurredAt: new Date('2026-03-10T00:00:00.000Z'),
          convertedMinor: 300n,
        }),
        createRow({
          occurredAt: new Date('2026-04-10T00:00:00.000Z'),
          convertedMinor: 400n,
        }),
      ];
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [REPORT_MEASURE.MOVING_AVERAGE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(4);
      expect(grid.rows[0].cells[0]).toEqual({
        measure: REPORT_MEASURE.MOVING_AVERAGE,
        value: null,
      });
      expect(grid.rows[1].cells[0]).toEqual({
        measure: REPORT_MEASURE.MOVING_AVERAGE,
        value: null,
      });
      // (100 + 200 + 300) / 3 = 200
      expect(grid.rows[2].cells[0]).toEqual({
        measure: REPORT_MEASURE.MOVING_AVERAGE,
        value: '200',
      });
      // (200 + 300 + 400) / 3 = 300
      expect(grid.rows[3].cells[0]).toEqual({
        measure: REPORT_MEASURE.MOVING_AVERAGE,
        value: '300',
      });
    });

    it('budget returns null when no budget entry exists in budgetedMinorByBucket', () => {
      const rows = [
        createRow({ accountId: 'acc-budgeted', convertedMinor: 100n }),
        createRow({ accountId: 'acc-unbudgeted', convertedMinor: 200n }),
      ];
      const budgetMap = new Map<string, bigint>([['acc-budgeted', 500n]]);
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.ACCOUNT],
        measures: [REPORT_MEASURE.BUDGET, REPORT_MEASURE.VARIANCE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: budgetMap,
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(2);
      expect(grid.rows[0].key).toEqual(['acc-budgeted']);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.BUDGET, value: '500' },
        { measure: REPORT_MEASURE.VARIANCE, value: '400' }, // 500 - 100
      ]);

      expect(grid.rows[1].key).toEqual(['acc-unbudgeted']);
      expect(grid.rows[1].cells).toEqual([
        { measure: REPORT_MEASURE.BUDGET, value: null },
        { measure: REPORT_MEASURE.VARIANCE, value: null },
      ]);
    });

    it('emitted order sorts temporal and alphabetical composite dimensions correctly when rows arrive shuffled', () => {
      // Fixture arrives deliberately scrambled/shuffled:
      // Row 1: 2026-03-01, category "zeta"
      // Row 2: 2026-01-01, category "beta"
      // Row 3: 2026-01-01, category "alpha"
      // Row 4: 2026-02-01, category "gamma"
      const rows = [
        createRow({
          occurredAt: new Date('2026-03-15T00:00:00.000Z'),
          categoryId: 'zeta',
          convertedMinor: 10n,
        }),
        createRow({
          occurredAt: new Date('2026-01-15T00:00:00.000Z'),
          categoryId: 'beta',
          convertedMinor: 20n,
        }),
        createRow({
          occurredAt: new Date('2026-01-20T00:00:00.000Z'),
          categoryId: 'alpha',
          convertedMinor: 30n,
        }),
        createRow({
          occurredAt: new Date('2026-02-10T00:00:00.000Z'),
          categoryId: 'gamma',
          convertedMinor: 40n,
        }),
      ];

      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.MONTH, REPORT_DIMENSION.CATEGORY],
        measures: [REPORT_MEASURE.CONVERTED_VALUE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      // Expected sorted order:
      // 1. 2026-01-01, alpha
      // 2. 2026-01-01, beta
      // 3. 2026-02-01, gamma
      // 4. 2026-03-01, zeta
      expect(grid.rows.map((r) => r.key)).toEqual([
        ['2026-01-01', 'alpha'],
        ['2026-01-01', 'beta'],
        ['2026-02-01', 'gamma'],
        ['2026-03-01', 'zeta'],
      ]);
    });

    it('sorts bucket keys by deterministic code-point order', () => {
      const rows = ['ä', 'z', 'A', 'a', '10', '2'].map((categoryId) =>
        createRow({ categoryId }),
      );

      const grid = buildReportGrid({
        rows,
        dimensions: [REPORT_DIMENSION.CATEGORY],
        measures: [REPORT_MEASURE.COUNT],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      });

      expect(grid.rows.map((row) => row.key[0])).toEqual([
        '10',
        '2',
        'A',
        'a',
        'z',
        'ä',
      ]);
    });

    it('allow-list rejects unknown or injected dimensions and measures by throwing', () => {
      const maliciousDimension =
        'date; DROP TABLE report_runs; --' as ReportDimension;
      expect(() =>
        buildReportGrid({
          rows: [],
          dimensions: [maliciousDimension],
          measures: [REPORT_MEASURE.COUNT],
          baseCurrency: 'USD',
          budgetedMinorByBucket: new Map(),
        }),
      ).toThrowError(/Invalid report dimension/);

      const maliciousMeasure = "'; DROP TABLE workspaces; --" as ReportMeasure;
      expect(() =>
        buildReportGrid({
          rows: [],
          dimensions: [REPORT_DIMENSION.DAY],
          measures: [maliciousMeasure],
          baseCurrency: 'USD',
          budgetedMinorByBucket: new Map(),
        }),
      ).toThrowError(/Invalid report measure/);
    });
  });

  describe('Comprehensive dimension and measure calculations', () => {
    it('handles all temporal dimensions: date, day, week, month, quarter, year', () => {
      const date = new Date('2026-03-15T10:00:00.000Z'); // Sunday
      const row = createRow({ occurredAt: date, convertedMinor: 100n });

      for (const [dim, expectedKey] of [
        [REPORT_DIMENSION.DATE, '2026-03-15'],
        [REPORT_DIMENSION.DAY, '2026-03-15'],
        [REPORT_DIMENSION.WEEK, '2026-03-09'],
        [REPORT_DIMENSION.MONTH, '2026-03-01'],
        [REPORT_DIMENSION.QUARTER, '2026-01-01'],
        [REPORT_DIMENSION.YEAR, '2026-01-01'],
      ] as const) {
        const grid = buildReportGrid({
          rows: [row],
          dimensions: [dim],
          measures: [REPORT_MEASURE.CONVERTED_VALUE],
          baseCurrency: 'USD',
          budgetedMinorByBucket: new Map(),
        });
        expect(grid.rows[0].key).toEqual([expectedKey]);
      }
    });

    it('handles all categorical dimensions: account, account_type, currency, member, status, transaction_type', () => {
      const row = createRow({
        accountId: 'acc-123',
        accountType: 'savings',
        currency: 'EUR',
        memberId: 'mem-456',
        status: 'cleared',
        type: 'fund_contribution',
      });

      for (const [dim, expectedKey] of [
        [REPORT_DIMENSION.ACCOUNT, 'acc-123'],
        [REPORT_DIMENSION.ACCOUNT_TYPE, 'savings'],
        [REPORT_DIMENSION.CURRENCY, 'EUR'],
        [REPORT_DIMENSION.MEMBER, 'mem-456'],
        [REPORT_DIMENSION.STATUS, 'cleared'],
        [REPORT_DIMENSION.TRANSACTION_TYPE, 'fund_contribution'],
      ] as const) {
        const grid = buildReportGrid({
          rows: [row],
          dimensions: [dim],
          measures: [REPORT_MEASURE.COUNT],
          baseCurrency: 'USD',
          budgetedMinorByBucket: new Map(),
        });
        expect(grid.rows[0].key).toEqual([expectedKey]);
      }
    });

    it('computes statistical measures: minimum, maximum, average, percentage, and handles untagged', () => {
      const rows = [
        createRow({ accountId: 'acc-1', convertedMinor: 100n, tags: [] }),
        createRow({ accountId: 'acc-1', convertedMinor: 300n, tags: [] }),
        createRow({ accountId: 'acc-2', convertedMinor: 600n, tags: [] }),
      ];
      // Grand total = 1000n
      // Bucket acc-1: min = 100, max = 300, avg = 200, pct = 40.00% (400 / 1000 = 40.00%)
      // Bucket acc-2: min = 600, max = 600, avg = 600, pct = 60.00%
      const input: ReportEngineInput = {
        rows,
        dimensions: [REPORT_DIMENSION.ACCOUNT],
        measures: [
          REPORT_MEASURE.MINIMUM,
          REPORT_MEASURE.MAXIMUM,
          REPORT_MEASURE.AVERAGE,
          REPORT_MEASURE.PERCENTAGE,
        ],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      };

      const grid = buildReportGrid(input);

      expect(grid.rows).toHaveLength(2);
      expect(grid.rows[0].key).toEqual(['acc-1']);
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.MINIMUM, value: '100' },
        { measure: REPORT_MEASURE.MAXIMUM, value: '300' },
        { measure: REPORT_MEASURE.AVERAGE, value: '200' },
        { measure: REPORT_MEASURE.PERCENTAGE, value: '40.00' },
      ]);
      expect(grid.rows[1].key).toEqual(['acc-2']);
      expect(grid.rows[1].cells).toEqual([
        { measure: REPORT_MEASURE.MINIMUM, value: '600' },
        { measure: REPORT_MEASURE.MAXIMUM, value: '600' },
        { measure: REPORT_MEASURE.AVERAGE, value: '600' },
        { measure: REPORT_MEASURE.PERCENTAGE, value: '60.00' },
      ]);
    });

    it('handles untagged dimension value when tags array is empty', () => {
      const row = createRow({ tags: [] });
      const grid = buildReportGrid({
        rows: [row],
        dimensions: [REPORT_DIMENSION.TAG],
        measures: [REPORT_MEASURE.COUNT],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      });
      expect(grid.rows[0].key).toEqual(['untagged']);
    });

    it('returns empty grid when rows input is empty', () => {
      const grid = buildReportGrid({
        rows: [],
        dimensions: [REPORT_DIMENSION.DAY],
        measures: [REPORT_MEASURE.CONVERTED_VALUE],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map(),
      });
      expect(grid.rows).toEqual([]);
      expect(grid.dimensions).toEqual([REPORT_DIMENSION.DAY]);
      expect(grid.measures).toEqual([REPORT_MEASURE.CONVERTED_VALUE]);
      expect(grid.warnings).toEqual([]);
    });

    it('preserves negative values without clamping in variance and balance', () => {
      const rows = [
        createRow({
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
          convertedMinor: -500n,
        }),
      ];
      const grid = buildReportGrid({
        rows,
        dimensions: [REPORT_DIMENSION.MONTH],
        measures: [
          REPORT_MEASURE.CONVERTED_VALUE,
          REPORT_MEASURE.BALANCE,
          REPORT_MEASURE.VARIANCE,
        ],
        baseCurrency: 'USD',
        budgetedMinorByBucket: new Map([['2026-01-01', -200n]]),
      });
      // variance = budget - S = -200 - (-500) = +300
      expect(grid.rows[0].cells).toEqual([
        { measure: REPORT_MEASURE.CONVERTED_VALUE, value: '-500' },
        { measure: REPORT_MEASURE.BALANCE, value: '-500' },
        { measure: REPORT_MEASURE.VARIANCE, value: '300' },
      ]);
    });
  });
});
