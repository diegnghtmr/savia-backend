import { describe, expect, it, vi } from 'vitest';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import type { ExportRows } from '../../src/exports/export.port.js';
import { ExportJobHandler } from '../../src/exports/export-job.handler.js';
import type { PostgresExportAdapter } from '../../src/exports/postgres-export.adapter.js';
import type { JobExecutionContext } from '../../src/platform/job-handler.port.js';
import type { ExportJobPayload } from '../../src/exports/export-job-payload.js';
import {
  serialize,
  serializeCsv,
  serializeJsonBackup,
  serializeXlsx,
} from '../../src/exports/export-serializers.js';
import {
  PINNED_CSV,
  PINNED_INSTANT,
  PINNED_JSON,
} from './pinned-export-golden.js';

function createPinnedFixture(): ExportRows {
  const accounts: Record<string, unknown>[] = [
    {
      id: 'acc-1',
      name: 'Checking, "Main"',
      note: 'Line 1\nLine 2',
      formula: '=SUM(A1:B2)',
      neutral: '-50.25',
      tabbed: '@special\tmention',
      balance: null,
    },
    {
      id: 'acc-2',
      name: 'Savings "High Yield", Ltd.',
      note: 'Single line',
      formula: '+100',
      neutral: '42.50',
      tabbed: 'normal',
      balance: 1000,
    },
  ];

  const transactions: Record<string, unknown>[] = Array.from(
    { length: 252 },
    (_, i) => ({
      id: `tx-${String(i).padStart(3, '0')}`,
      desc: i === 0 ? 'Item with "quotes" and, commas' : `Tx ${i}`,
      memo: i === 1 ? 'Comma, here' : null,
      note: i === 251 ? 'Boundary item\nwith newline' : null,
      formula: i === 2 ? '=HYPERLINK("http://example.com")' : null,
      amount: i === 3 ? -100 : i,
    }),
  );

  return { accounts, transactions };
}

function largeRows(rowCount = 50_000): readonly Record<string, unknown>[] {
  return Array.from({ length: rowCount }, (_, i) => ({
    id: `row-${String(i).padStart(6, '0')}`,
    name: `Name ${i} padding data to give serializer realistic work`,
    amount: (i * 13.37) % 10000,
    memo: `Memo ${i}, with occasional comma`,
    note: i % 100 === 0 ? 'Multi\nline' : 'Single line',
  }));
}

function largeExportRows(rowCount = 50_000): ExportRows {
  const half = Math.floor(rowCount / 2);
  return {
    accounts: largeRows(half),
    transactions: largeRows(rowCount - half),
  };
}

describe('export serializers delivery budget and formatting', () => {
  describe('byte-identity and frozen instant', () => {
    it('produces byte-identical CSV output matching captured golden bytes', async () => {
      const fixture = createPinnedFixture();
      const result = await serialize('csv', fixture, {
        asOf: PINNED_INSTANT,
      });
      expect(result.contentType).toBe('text/csv');
      expect(result.extension).toBe('csv');
      expect(result.content.toString('utf8')).toBe(PINNED_CSV);
    });

    it('produces byte-identical JSON backup output matching captured golden bytes with 2-space indentation', async () => {
      const fixture = createPinnedFixture();
      const result = await serialize('json_backup', fixture, {
        asOf: PINNED_INSTANT,
      });
      expect(result.contentType).toBe('application/json');
      expect(result.extension).toBe('json');
      expect(result.content.toString('utf8')).toBe(PINNED_JSON);
    });

    it('pins exportedAt to the frozen asOf timestamp without wall-clock dependence', () => {
      const rows: ExportRows = {
        accounts: [{ id: 'acc-fixed' }],
        transactions: [],
      };
      const fixedAsOf = '2026-01-01T00:00:00.000Z';
      const output = serializeJsonBackup(rows, { asOf: fixedAsOf });
      const parsed = JSON.parse(output.toString('utf8')) as {
        exportedAt: string;
      };
      expect(parsed.exportedAt).toBe(fixedAsOf);
    });
  });

  describe('CSV serialization budget', () => {
    it('rejects when remaining budget is already exhausted on entry', async () => {
      const large = largeRows(100);
      expect(() =>
        serializeCsv(large, {
          remainingMs: () => 0,
        }),
      ).toThrow(DeliveryDeadlineExceededError);
    });

    it('rejects when signal is already aborted', async () => {
      const large = largeRows(100);
      expect(() =>
        serializeCsv(large, {
          signal: AbortSignal.abort(),
        }),
      ).toThrow(DeliveryDeadlineExceededError);
    });

    it('aborts part-way through a 50,000-row dataset under ~5 ms budget within sane tolerance (< 2000 ms)', () => {
      const large = largeRows(50_000);
      const started = performance.now();
      expect(() =>
        serializeCsv(large, {
          remainingMs: () => 5 - (performance.now() - started),
        }),
      ).toThrow(DeliveryDeadlineExceededError);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(2_000);
    });

    it('forwards options to the CSV serializer in serialize()', async () => {
      await expect(
        serialize(
          'csv',
          { accounts: [{ id: 1 }], transactions: [] },
          {
            remainingMs: () => 0,
          },
        ),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    });
  });

  describe('JSON backup serialization budget', () => {
    it('rejects when remaining budget is already exhausted on entry', () => {
      const large = largeExportRows(100);
      expect(() =>
        serializeJsonBackup(large, {
          remainingMs: () => 0,
        }),
      ).toThrow(DeliveryDeadlineExceededError);
    });

    it('rejects when signal is already aborted', () => {
      const large = largeExportRows(100);
      expect(() =>
        serializeJsonBackup(large, {
          signal: AbortSignal.abort(),
        }),
      ).toThrow(DeliveryDeadlineExceededError);
    });

    it('aborts part-way through a 50,000-row dataset under ~5 ms budget within sane tolerance (< 2000 ms)', () => {
      const large = largeExportRows(50_000);
      const started = performance.now();
      expect(() =>
        serializeJsonBackup(large, {
          remainingMs: () => 5 - (performance.now() - started),
        }),
      ).toThrow(DeliveryDeadlineExceededError);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(2_000);
    });

    it('checks deadline budget before each batch during JSON array formatting', () => {
      let callCount = 0;
      const accounts = Array.from({ length: 600 }, (_, i) => ({
        id: `acc-${i}`,
      }));
      expect(() =>
        serializeJsonBackup(
          { accounts, transactions: [] },
          {
            remainingMs: () => {
              callCount++;
              // call 1: entry check (ok)
              // call 2: batch 1 (0..250) (ok)
              // call 3: batch 2 (250..500) -> exhausted
              return callCount === 3 ? 0 : 10_000;
            },
          },
        ),
      ).toThrow(DeliveryDeadlineExceededError);
    });
  });

  describe('XLSX serialization budget', () => {
    it('rejects when remaining budget is already exhausted on entry', async () => {
      const large = largeRows(100);
      await expect(
        serializeXlsx(large, {
          remainingMs: () => 0,
        }),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    });

    it('rejects when signal is already aborted', async () => {
      const large = largeRows(100);
      await expect(
        serializeXlsx(large, {
          signal: AbortSignal.abort(),
        }),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    });

    it('aborts part-way through a 50,000-row dataset under ~5 ms budget within sane tolerance (< 2000 ms)', async () => {
      const large = largeRows(50_000);
      const started = performance.now();
      await expect(
        serializeXlsx(large, {
          remainingMs: () => 5 - (performance.now() - started),
        }),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(2_000);
    });

    it('checks deadline budget before each row in XLSX serialization', async () => {
      let callCount = 0;
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }));
      await expect(
        serializeXlsx(rows, {
          remainingMs: () => {
            callCount++;
            // call 1: entry check
            // call 2: row 1
            // call 3: row 2 -> exhausted
            return callCount >= 3 && callCount <= 10 ? 0 : 10_000;
          },
        }),
      ).rejects.toBeInstanceOf(DeliveryDeadlineExceededError);
    });
  });

  describe('Normal-size serialization under normal budget', () => {
    it('serializes CSV, JSON backup, and XLSX successfully under normal cap', async () => {
      const fixture = createPinnedFixture();
      const options = {
        remainingMs: () => 5_000,
        asOf: PINNED_INSTANT,
      };

      const csv = await serialize('csv', fixture, options);
      expect(csv.contentType).toBe('text/csv');
      expect(csv.content.length).toBeGreaterThan(0);

      const json = await serialize('json_backup', fixture, options);
      expect(json.contentType).toBe('application/json');
      expect(json.content.length).toBeGreaterThan(0);

      const xlsx = await serialize('xlsx', fixture, options);
      expect(xlsx.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(xlsx.content.length).toBeGreaterThan(0);
    });
  });

  describe('Handler-level render budget and storage isolation', () => {
    it('an export render under a tiny cap rejects with the deadline error and performs zero uploads and zero signs', async () => {
      let uploadCalls = 0;
      let signCalls = 0;
      const mockStorage = {
        upload: vi.fn(async () => {
          uploadCalls++;
        }),
        sign: vi.fn(async () => {
          signCalls++;
          return { url: 'https://storage.test/file', expiresAt: new Date() };
        }),
        remove: vi.fn(async () => {}),
      };
      const mockAdapter = {} as unknown as PostgresExportAdapter;
      const handler = new ExportJobHandler(mockAdapter, mockStorage);

      const large = largeExportRows(50_000);
      const context: JobExecutionContext<ExportJobPayload> = {
        jobId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        actorId: '33333333-3333-4333-8333-333333333333',
        attemptCount: 1,
        payload: {
          version: 1,
          exportJobId: '44444444-4444-4444-8444-444444444444',
          format: 'csv',
          resource: 'all',
          resourceId: null,
          from: null,
          to: null,
          objectKey: '22222222-2222-4222-8222-222222222222/export.csv',
          asOf: '2026-09-16T12:00:00.000Z',
        },
      };

      await expect(handler.render(context, large, 5)).rejects.toBeInstanceOf(
        DeliveryDeadlineExceededError,
      );

      expect(uploadCalls).toBe(0);
      expect(signCalls).toBe(0);
      expect(mockStorage.upload).not.toHaveBeenCalled();
      expect(mockStorage.sign).not.toHaveBeenCalled();
    });
  });
});
