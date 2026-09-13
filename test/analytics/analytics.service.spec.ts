import { describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  ADVANCED_METRIC,
  ANALYTICS_OUTCOMES,
  type AnalyticsStore,
  type TransactionFlowRow,
  type AccountNativeBalanceRow,
  type DebtOutstandingBalanceRow,
  type AdvancedAnalyticsOkOutcome,
  type SubscriptionPriceRow,
  type DebtPaymentCostRow,
} from '../../src/analytics/analytics.port.js';
import {
  AnalyticsService,
  generateBucketPeriods,
} from '../../src/analytics/analytics.service.js';

describe('AnalyticsService', () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const subject = '00000000-0000-4000-8000-000000000099';

  const fakeTx = {
    run: async <T>(
      _sub: string,
      cb: (client: TransactionClient) => Promise<T>,
    ): Promise<T> => {
      return cb({
        query: async () => ({ rows: [], rowCount: 0 }),
      } as unknown as TransactionClient);
    },
  };

  const createMockStore = (
    overrides: Partial<AnalyticsStore> = {},
  ): AnalyticsStore => ({
    readActiveRole: async () => 'owner',
    readWorkspaceBaseCurrency: async () => 'USD',
    readAccountNativeBalances: async () => [],
    readDebtOutstandingBalances: async () => [],
    readTransactionsInPeriod: async () => [],
    readSubscriptionsWithPreviousAmount: async () => [],
    readActiveSubscriptions: async () => [],
    readDebtPaymentCostsInPeriod: async () => [],
    readOverlappingBudgetAllocations: async () => [],
    readOverlappingBudgetSpend: async () => [],
    findExchangeRate: async () => '1.0',
    readScheduledOutflows: async () => [],
    readActiveDebtsWithoutScheduledAmount: async () => 0,
    ...overrides,
  });

  describe('getSummary', () => {
    it('returns FORBIDDEN if caller is not an active member', async () => {
      const store = createMockStore({ readActiveRole: async () => undefined });
      const service = new AnalyticsService(fakeTx, store);
      const res = await service.getSummary(subject, {
        workspaceId,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.FORBIDDEN);
    });

    it('returns summary with exact computed fields in base currency', async () => {
      const accounts: AccountNativeBalanceRow[] = [
        { id: 'a1', currency: 'USD', nativeBalanceMinor: '100000' },
      ];
      const debts: DebtOutstandingBalanceRow[] = [
        { id: 'd1', currency: 'USD', outstandingBalanceMinor: '40000' },
      ];
      const txns: TransactionFlowRow[] = [
        {
          id: 't1',
          type: 'income',
          amountMinor: '50000',
          currency: 'USD',
          occurredAt: new Date('2026-01-10T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't2',
          type: 'expense',
          amountMinor: '20000',
          currency: 'USD',
          occurredAt: new Date('2026-01-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't3',
          type: 'refund',
          amountMinor: '5000',
          currency: 'USD',
          occurredAt: new Date('2026-01-20T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
      ];

      const store = createMockStore({
        readAccountNativeBalances: async () => accounts,
        readDebtOutstandingBalances: async () => debts,
        readTransactionsInPeriod: async () => txns,
      });
      const service = new AnalyticsService(fakeTx, store);
      const res = await service.getSummary(subject, {
        workspaceId,
        from: '2026-01-01',
        to: '2026-01-31',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      expect(res.summary.periodStart).toBe('2026-01-01');
      expect(res.summary.periodEnd).toBe('2026-01-31');
      expect(res.summary.baseCurrency).toBe('USD');
      // assets: 100000
      expect(res.summary.assets.amountMinor).toBe('100000');
      // debts: 40000
      expect(res.summary.debts.amountMinor).toBe('40000');
      // netWorth: 100000 - 40000 = 60000
      expect(res.summary.netWorth.amountMinor).toBe('60000');
      // income: 50000
      expect(res.summary.income.amountMinor).toBe('50000');
      // expenses: 20000 - 5000 = 15000
      expect(res.summary.expenses.amountMinor).toBe('15000');
      // savingsCapacity: 50000 - 15000 = 35000
      expect(res.summary.savingsCapacity.amountMinor).toBe('35000');
      // No planned budget -> omitted
      expect(res.summary.budgetUtilizationPercent).toBeUndefined();
    });

    it('returns MISSING_RATE when conversion rate is not found', async () => {
      const accounts: AccountNativeBalanceRow[] = [
        { id: 'a1', currency: 'EUR', nativeBalanceMinor: '100000' },
      ];
      const store = createMockStore({
        readAccountNativeBalances: async () => accounts,
        findExchangeRate: async () => undefined,
      });
      const service = new AnalyticsService(fakeTx, store);
      const res = await service.getSummary(subject, {
        workspaceId,
        from: '2026-01-01',
        to: '2026-01-31',
        presentationCurrency: 'USD',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.MISSING_RATE);
      if (res.kind === ANALYTICS_OUTCOMES.MISSING_RATE) {
        expect(res.fromCurrency).toBe('EUR');
        expect(res.toCurrency).toBe('USD');
      }
    });
  });

  describe('getCashFlow', () => {
    it('produces gap-free bucketed series and running cumulative total', async () => {
      const txns: TransactionFlowRow[] = [
        {
          id: 't1',
          type: 'income',
          amountMinor: '3000',
          currency: 'USD',
          occurredAt: new Date('2026-01-05T00:00:00Z'),
          categoryId: 'c1',
          categoryName: 'Groceries',
        },
        {
          id: 't2',
          type: 'expense',
          amountMinor: '1000',
          currency: 'USD',
          occurredAt: new Date('2026-01-08T00:00:00Z'),
          categoryId: 'c1',
          categoryName: 'Groceries',
        },
        {
          id: 't3',
          type: 'expense',
          amountMinor: '500',
          currency: 'USD',
          occurredAt: new Date('2026-03-12T00:00:00Z'),
          categoryId: 'c2',
          categoryName: 'Utilities',
        },
      ];

      const store = createMockStore({
        readTransactionsInPeriod: async () => txns,
      });
      const service = new AnalyticsService(fakeTx, store);
      const res = await service.getCashFlow(subject, {
        workspaceId,
        from: '2026-01-01',
        to: '2026-03-31',
        granularity: 'month',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 3 months: 2026-01-01, 2026-02-01, 2026-03-01
      expect(res.analytics.series).toHaveLength(3);
      expect(res.analytics.series[0].period).toBe('2026-01-01');
      expect(res.analytics.series[0].value.amountMinor).toBe('2000'); // 3000 - 1000
      expect(res.analytics.series[0].secondaryValue.amountMinor).toBe('2000');

      // Month 2 is empty -> gap-free 0 value, running total persists
      expect(res.analytics.series[1].period).toBe('2026-02-01');
      expect(res.analytics.series[1].value.amountMinor).toBe('0');
      expect(res.analytics.series[1].secondaryValue.amountMinor).toBe('2000');

      // Month 3: -500 net flow, running total 1500
      expect(res.analytics.series[2].period).toBe('2026-03-01');
      expect(res.analytics.series[2].value.amountMinor).toBe('-500');
      expect(res.analytics.series[2].secondaryValue.amountMinor).toBe('1500');

      // Categories: Groceries 1000 (66.67%), Utilities 500 (33.33%)
      expect(res.analytics.categories).toHaveLength(2);
      expect(res.analytics.categories[0].categoryName).toBe('Groceries');
      expect(res.analytics.categories[0].amount.amountMinor).toBe('1000');
      expect(res.analytics.categories[1].categoryName).toBe('Utilities');
      expect(res.analytics.categories[1].amount.amountMinor).toBe('500');
    });

    it('returns empty categories array when total expenses is zero', async () => {
      const store = createMockStore({
        readTransactionsInPeriod: async () => [],
      });
      const service = new AnalyticsService(fakeTx, store);
      const res = await service.getCashFlow(subject, {
        workspaceId,
        from: '2026-01-01',
        to: '2026-01-31',
        granularity: 'month',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;
      expect(res.analytics.categories).toEqual([]);
    });
  });

  describe('getAdvancedAnalytics', () => {
    const fixedClock = new Date('2026-09-04T12:00:00.000Z');

    it('returns FORBIDDEN if caller is not an active member', async () => {
      const store = createMockStore({ readActiveRole: async () => undefined });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.RECURRING_VS_VARIABLE,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.FORBIDDEN);
    });

    it('returns MISSING_RATE when exchange rate is missing for conversion', async () => {
      const store = createMockStore({
        findExchangeRate: async () => undefined,
        readTransactionsInPeriod: async () => [
          {
            id: 't1',
            type: 'expense',
            amountMinor: '1000',
            currency: 'EUR',
            occurredAt: new Date('2026-01-10T00:00:00Z'),
            categoryId: null,
            categoryName: null,
          },
        ],
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.WEEKDAY_HEATMAP,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.MISSING_RATE);
    });

    it('emits generatedAt exactly matching the injected clock (determinism test)', async () => {
      const store = createMockStore();
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.WEEKDAY_HEATMAP,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      const ok = res as AdvancedAnalyticsOkOutcome;
      expect(ok.analytics.generatedAt).toBe('2026-09-04T12:00:00.000Z');
    });

    it('serialises every AmountMinor into string and JSON.stringify does not throw (serialisation test)', async () => {
      const store = createMockStore({
        readTransactionsInPeriod: async () => [
          {
            id: 't1',
            type: 'income',
            amountMinor: '12345',
            currency: 'USD',
            occurredAt: new Date('2026-01-15T00:00:00Z'),
            categoryId: null,
            categoryName: null,
          },
          {
            id: 't2',
            type: 'expense',
            amountMinor: '4567',
            currency: 'USD',
            occurredAt: new Date('2026-01-20T00:00:00Z'),
            categoryId: null,
            categoryName: null,
          },
        ],
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.MONTHLY_SAVINGS_CAPACITY,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      const ok = res as AdvancedAnalyticsOkOutcome;
      expect(() => JSON.stringify(ok.analytics)).not.toThrow();

      // Check that AmountMinor fields in data are string matching ^-?[0-9]+$
      const series = ok.analytics.data.series as Array<Record<string, unknown>>;
      expect(series).toBeDefined();
      expect(series.length).toBeGreaterThan(0);
      const first = series[0];
      expect(typeof first.incomeMinor).toBe('string');
      expect(first.incomeMinor).toMatch(/^-?[0-9]+$/);
      expect(typeof first.expensesMinor).toBe('string');
      expect(first.expensesMinor).toMatch(/^-?[0-9]+$/);
      expect(typeof first.savingsCapacityMinor).toBe('string');
      expect(first.savingsCapacityMinor).toMatch(/^-?[0-9]+$/);
    });

    it('names extrapolation and basisMonths in balance_projection explanation', async () => {
      const store = createMockStore({
        readAccountNativeBalances: async () => [
          { id: 'a1', currency: 'USD', nativeBalanceMinor: '500000' },
        ],
        readTransactionsInPeriod: async () => [
          {
            id: 't1',
            type: 'income',
            amountMinor: '100000',
            currency: 'USD',
            occurredAt: new Date('2026-01-15T00:00:00Z'),
            categoryId: null,
            categoryName: null,
          },
        ],
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.BALANCE_PROJECTION,
        from: '2026-01-01',
        to: '2026-03-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      const ok = res as AdvancedAnalyticsOkOutcome;
      expect(ok.analytics.explanation).toContain('extrapolation');
      expect(ok.analytics.explanation).toContain('basisMonths');
    });

    it('mentions non-zero exclusion count in explanation when subscriptions are unclassified', async () => {
      const store = createMockStore({
        readActiveSubscriptions: async () => [
          {
            currentAmountMinor: '5000',
            currentCurrency: 'USD',
            frequency: 'unrecognized_unknown_freq',
          },
        ],
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.RECURRING_VS_VARIABLE,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      const ok = res as AdvancedAnalyticsOkOutcome;
      expect(ok.analytics.explanation).toContain(
        '1 subscription(s) could not be classified',
      );
    });

    it('mentions non-zero exclusion count in explanation when subscriptions have currency mismatch or zero previous', async () => {
      const store = createMockStore({
        readSubscriptionsWithPreviousAmount: async () => [
          {
            id: 's1',
            payeeName: 'Service A',
            currentAmountMinor: '1000',
            currentCurrency: 'EUR',
            previousAmountMinor: '900',
            previousCurrency: 'USD',
          },
          {
            id: 's2',
            payeeName: 'Service B',
            currentAmountMinor: '1000',
            currentCurrency: 'USD',
            previousAmountMinor: '0',
            previousCurrency: 'USD',
          },
        ],
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.SUBSCRIPTION_PRICE_INCREASES,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      const ok = res as AdvancedAnalyticsOkOutcome;
      expect(ok.analytics.explanation).toContain('currency mismatch');
      expect(ok.analytics.explanation).toContain('zero previous amount');
    });

    it('mentions non-zero debtsWithoutScheduledAmount in financial_calendar explanation', async () => {
      const store = createMockStore({
        readActiveDebtsWithoutScheduledAmount: async () => 2,
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.FINANCIAL_CALENDAR,
        from: '2026-01-01',
        to: '2026-01-31',
      });
      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      const ok = res as AdvancedAnalyticsOkOutcome;
      expect(ok.analytics.explanation).toContain(
        '2 active debt(s) without scheduled payment amount',
      );
    });
    function assertNoBigintAndValidAmounts(node: unknown): number {
      expect(typeof node).not.toBe('bigint');
      if (node === null || typeof node !== 'object') {
        return 0;
      }
      let verifiedAmountCount = 0;
      if (Array.isArray(node)) {
        for (const item of node) {
          verifiedAmountCount += assertNoBigintAndValidAmounts(item);
        }
        return verifiedAmountCount;
      }
      for (const [key, value] of Object.entries(node)) {
        expect(typeof value).not.toBe('bigint');
        if (key.endsWith('Minor') || key === 'amountMinor') {
          expect(typeof value).toBe('string');
          expect(value).toMatch(/^-?[0-9]+$/);
          verifiedAmountCount += 1;
        }
        verifiedAmountCount += assertNoBigintAndValidAmounts(value);
      }
      return verifiedAmountCount;
    }

    it('wires monthly_savings_capacity end-to-end with real flow data, currency conversion, serialisation and explanation', async () => {
      // Hand derivation for monthly_savings_capacity:
      // Period: 2026-01-01 to 2026-02-28 (2 monthly buckets: 2026-01-01, 2026-02-01).
      // Base currency: USD. Exchange rate EUR->USD = 1.5.
      // 2026-01:
      //   Income: t1 (USD 100000) = 100000
      //   Expenses: t2 expense (USD 30000) - t3 refund (USD 5000) = 25000
      //   Savings Capacity: 100000 - 25000 = 75000
      // 2026-02:
      //   Income: t4 (EUR 20000 * 1.5) = 30000
      //   Expenses: t5 (USD 40000) = 40000
      //   Savings Capacity: 30000 - 40000 = -10000
      const txns: TransactionFlowRow[] = [
        {
          id: 't1',
          type: 'income',
          amountMinor: '100000',
          currency: 'USD',
          occurredAt: new Date('2026-01-10T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't2',
          type: 'expense',
          amountMinor: '30000',
          currency: 'USD',
          occurredAt: new Date('2026-01-15T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't3',
          type: 'refund',
          amountMinor: '5000',
          currency: 'USD',
          occurredAt: new Date('2026-01-20T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't4',
          type: 'income',
          amountMinor: '20000',
          currency: 'EUR',
          occurredAt: new Date('2026-02-05T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't5',
          type: 'expense',
          amountMinor: '40000',
          currency: 'USD',
          occurredAt: new Date('2026-02-12T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
      ];

      const store = createMockStore({
        readTransactionsInPeriod: async () => txns,
        findExchangeRate: async (_c, _w, from, to) =>
          from === 'EUR' && to === 'USD' ? '1.5' : '1.0',
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.MONTHLY_SAVINGS_CAPACITY,
        from: '2026-01-01',
        to: '2026-02-28',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 1. Outcome and shape
      expect(res.analytics.metric).toBe(
        ADVANCED_METRIC.MONTHLY_SAVINGS_CAPACITY,
      );
      expect(Object.keys(res.analytics.data).sort()).toEqual(['series']);
      const series = res.analytics.data.series;
      expect(Array.isArray(series)).toBe(true);
      if (!Array.isArray(series)) return;
      expect(series).toHaveLength(2);
      for (const point of series) {
        expect(Object.keys(point).sort()).toEqual([
          'expensesMinor',
          'incomeMinor',
          'month',
          'savingsCapacityMinor',
        ]);
      }
      expect(series[0]).toEqual({
        month: '2026-01-01',
        incomeMinor: '100000',
        expensesMinor: '25000',
        savingsCapacityMinor: '75000',
      });
      expect(series[1]).toEqual({
        month: '2026-02-01',
        incomeMinor: '30000',
        expensesMinor: '40000',
        savingsCapacityMinor: '-10000',
      });

      // 2. No bigint escapes & recursive amount string format check
      expect(() => JSON.stringify(res)).not.toThrow();
      const verifiedAmounts = assertNoBigintAndValidAmounts(res);
      expect(verifiedAmounts).toBeGreaterThan(0);

      // 3. generatedAt equals injected clock
      expect(res.analytics.generatedAt).toBe(fixedClock.toISOString());

      // 4. Non-empty explanation
      expect(typeof res.analytics.explanation).toBe('string');
      if (typeof res.analytics.explanation !== 'string') return;
      expect(res.analytics.explanation.length).toBeGreaterThan(0);
      expect(res.analytics.explanation).toBe(
        'Monthly savings capacity series over the period.',
      );
    });

    it('wires income_stability end-to-end with real flow data, basis count, serialisation and explanation', async () => {
      // Hand derivation for income_stability:
      // Period: 2026-01-01 to 2026-03-31 (3 monthly buckets: 2026-01-01, 2026-02-01, 2026-03-01).
      // Base currency: USD. Rate EUR->USD = 2.0.
      // Jan 2026: t1 income USD 100000 = 100000
      // Feb 2026: t2 income USD 200000 = 200000
      // Mar 2026: t3 income EUR 150000 * 2.0 = 300000
      // monthsCounted = 3
      // minMonthlyIncomeMinor = 100000
      // maxMonthlyIncomeMinor = 300000
      // meanMonthlyIncomeMinor = (100000 + 200000 + 300000) / 3 = 200000
      // Population variance:
      //   N = 3, T = 600000, Q = 100000^2 + 200000^2 + 300000^2 = 1.4e11
      //   S = 3 * 1.4e11 - 600000^2 = 4.2e11 - 3.6e11 = 6e10
      //   sqrt(S) = sqrt(6e10) ~= 244948.974
      //   stdDev = 244948.974 / 3 ~= 81649.658
      //   CV% = 81649.658 / 200000 * 100 = 40.82%
      // Explanation mentions basis count: "3 month(s)"
      const txns: TransactionFlowRow[] = [
        {
          id: 't1',
          type: 'income',
          amountMinor: '100000',
          currency: 'USD',
          occurredAt: new Date('2026-01-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't2',
          type: 'income',
          amountMinor: '200000',
          currency: 'USD',
          occurredAt: new Date('2026-02-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't3',
          type: 'income',
          amountMinor: '150000',
          currency: 'EUR',
          occurredAt: new Date('2026-03-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
      ];

      const store = createMockStore({
        readTransactionsInPeriod: async () => txns,
        findExchangeRate: async (_c, _w, from, to) =>
          from === 'EUR' && to === 'USD' ? '2.0' : '1.0',
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.INCOME_STABILITY,
        from: '2026-01-01',
        to: '2026-03-31',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 1. Outcome and shape
      expect(res.analytics.metric).toBe(ADVANCED_METRIC.INCOME_STABILITY);
      expect(Object.keys(res.analytics.data).sort()).toEqual([
        'coefficientOfVariationPercent',
        'maxMonthlyIncomeMinor',
        'meanMonthlyIncomeMinor',
        'minMonthlyIncomeMinor',
        'monthsCounted',
      ]);
      expect(res.analytics.data.monthsCounted).toBe(3);
      expect(res.analytics.data.meanMonthlyIncomeMinor).toBe('200000');
      expect(res.analytics.data.minMonthlyIncomeMinor).toBe('100000');
      expect(res.analytics.data.maxMonthlyIncomeMinor).toBe('300000');
      expect(res.analytics.data.coefficientOfVariationPercent).toBe(40.82);

      // 2. No bigint escapes & recursive amount string format check
      expect(() => JSON.stringify(res)).not.toThrow();
      const verifiedAmounts = assertNoBigintAndValidAmounts(res);
      expect(verifiedAmounts).toBeGreaterThan(0);

      // 3. generatedAt equals injected clock
      expect(res.analytics.generatedAt).toBe(fixedClock.toISOString());

      // 4. Non-empty explanation mentioning basis count
      expect(typeof res.analytics.explanation).toBe('string');
      if (typeof res.analytics.explanation !== 'string') return;
      expect(res.analytics.explanation.length).toBeGreaterThan(0);
      expect(res.analytics.explanation).toContain('3 month(s)');
      expect(res.analytics.explanation).toBe(
        'Income stability analysis over 3 month(s) based on monthly income variation.',
      );
    });

    it('wires quarterly_average_comparison end-to-end with real flow data, quarter averages, serialisation and explanation', async () => {
      // Hand derivation for quarterly_average_comparison:
      // Period: 2026-01-01 to 2026-06-30 (two quarters: 2026-Q1 and 2026-Q2).
      // Base currency: USD. Rate EUR->USD = 2.0.
      // 2026-Q1 (Jan, Feb, Mar):
      //   Jan: income 100000, expenses 0, savings 100000
      //   Feb: income 200000, expenses 0, savings 200000
      //   Mar: income 300000, expenses 60000, savings 240000
      //   monthsCounted = 3
      //   averageMonthlyIncomeMinor = (100000 + 200000 + 300000) / 3 = 200000
      //   averageMonthlyExpensesMinor = 60000 / 3 = 20000
      //   averageMonthlySavingsCapacityMinor = (100000 + 200000 + 240000) / 3 = 180000
      //   savingsCapacityDeltaPercentVsPreviousQuarter = null (first quarter)
      // 2026-Q2 (Apr, May, Jun):
      //   Apr: income 300000, expenses 0, savings 300000
      //   May: income 300000, expenses 0, savings 300000
      //   Jun: income 300000, expenses (EUR 45000 * 2.0) = 90000, savings 210000
      //   monthsCounted = 3
      //   averageMonthlyIncomeMinor = (300000 + 300000 + 300000) / 3 = 300000
      //   averageMonthlyExpensesMinor = 90000 / 3 = 30000
      //   averageMonthlySavingsCapacityMinor = (300000 + 300000 + 210000) / 3 = 270000
      //   savingsCapacityDeltaPercentVsPreviousQuarter = ((270000 - 180000) / 180000) * 100 = 50%
      const txns: TransactionFlowRow[] = [
        {
          id: 't1',
          type: 'income',
          amountMinor: '100000',
          currency: 'USD',
          occurredAt: new Date('2026-01-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't2',
          type: 'income',
          amountMinor: '200000',
          currency: 'USD',
          occurredAt: new Date('2026-02-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't3',
          type: 'income',
          amountMinor: '300000',
          currency: 'USD',
          occurredAt: new Date('2026-03-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't4',
          type: 'expense',
          amountMinor: '60000',
          currency: 'USD',
          occurredAt: new Date('2026-03-20T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't5',
          type: 'income',
          amountMinor: '300000',
          currency: 'USD',
          occurredAt: new Date('2026-04-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't6',
          type: 'income',
          amountMinor: '300000',
          currency: 'USD',
          occurredAt: new Date('2026-05-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't7',
          type: 'income',
          amountMinor: '300000',
          currency: 'USD',
          occurredAt: new Date('2026-06-15T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't8',
          type: 'expense',
          amountMinor: '45000',
          currency: 'EUR',
          occurredAt: new Date('2026-06-20T12:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
      ];

      const store = createMockStore({
        readTransactionsInPeriod: async () => txns,
        findExchangeRate: async (_c, _w, from, to) =>
          from === 'EUR' && to === 'USD' ? '2.0' : '1.0',
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.QUARTERLY_AVERAGE_COMPARISON,
        from: '2026-01-01',
        to: '2026-06-30',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 1. Outcome and shape
      expect(res.analytics.metric).toBe(
        ADVANCED_METRIC.QUARTERLY_AVERAGE_COMPARISON,
      );
      expect(Object.keys(res.analytics.data).sort()).toEqual(['series']);
      const series = res.analytics.data.series;
      expect(Array.isArray(series)).toBe(true);
      if (!Array.isArray(series)) return;
      expect(series).toHaveLength(2);
      for (const point of series) {
        expect(Object.keys(point).sort()).toEqual([
          'averageMonthlyExpensesMinor',
          'averageMonthlyIncomeMinor',
          'averageMonthlySavingsCapacityMinor',
          'monthsCounted',
          'quarter',
          'savingsCapacityDeltaPercentVsPreviousQuarter',
        ]);
      }
      expect(series[0]).toEqual({
        quarter: '2026-Q1',
        monthsCounted: 3,
        averageMonthlyIncomeMinor: '200000',
        averageMonthlyExpensesMinor: '20000',
        averageMonthlySavingsCapacityMinor: '180000',
        savingsCapacityDeltaPercentVsPreviousQuarter: null,
      });
      expect(series[1]).toEqual({
        quarter: '2026-Q2',
        monthsCounted: 3,
        averageMonthlyIncomeMinor: '300000',
        averageMonthlyExpensesMinor: '30000',
        averageMonthlySavingsCapacityMinor: '270000',
        savingsCapacityDeltaPercentVsPreviousQuarter: 50,
      });

      // 2. No bigint escapes & recursive amount string format check
      expect(() => JSON.stringify(res)).not.toThrow();
      const verifiedAmounts = assertNoBigintAndValidAmounts(res);
      expect(verifiedAmounts).toBeGreaterThan(0);

      // 3. generatedAt equals injected clock
      expect(res.analytics.generatedAt).toBe(fixedClock.toISOString());

      // 4. Non-empty explanation
      expect(typeof res.analytics.explanation).toBe('string');
      if (typeof res.analytics.explanation !== 'string') return;
      expect(res.analytics.explanation.length).toBeGreaterThan(0);
      expect(res.analytics.explanation).toBe(
        'Quarterly average monthly income, expenses, and savings capacity comparison.',
      );
    });

    it('wires weekday_heatmap end-to-end with real flow data, 7-day distribution, serialisation and explanation', async () => {
      // Hand derivation for weekday_heatmap:
      // Period: 2026-01-01 to 2026-01-31. Base currency: USD. Rate EUR->USD = 2.0.
      // Monday (weekday 1, 2026-01-05):
      //   expense USD 10000 (+10000) + refund USD 2000 (-2000)
      //   transactionCount = 2, totalMinor = 8000
      // Tuesday (weekday 2, 2026-01-06):
      //   expense USD 15000 (+15000)
      //   transactionCount = 1, totalMinor = 15000
      // Wednesday (weekday 3, 2026-01-07):
      //   expense EUR 10000 * 2.0 (+20000)
      //   transactionCount = 1, totalMinor = 20000
      // Thursday (weekday 4, 2026-01-08):
      //   income USD 50000 -> builder excludes income rows entirely
      // Days 4..7:
      //   transactionCount = 0, totalMinor = 0
      const txns: TransactionFlowRow[] = [
        {
          id: 't1',
          type: 'expense',
          amountMinor: '10000',
          currency: 'USD',
          occurredAt: new Date('2026-01-05T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't2',
          type: 'refund',
          amountMinor: '2000',
          currency: 'USD',
          occurredAt: new Date('2026-01-05T14:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't3',
          type: 'expense',
          amountMinor: '15000',
          currency: 'USD',
          occurredAt: new Date('2026-01-06T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't4',
          type: 'expense',
          amountMinor: '10000',
          currency: 'EUR',
          occurredAt: new Date('2026-01-07T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
        {
          id: 't5',
          type: 'income',
          amountMinor: '50000',
          currency: 'USD',
          occurredAt: new Date('2026-01-08T10:00:00Z'),
          categoryId: null,
          categoryName: null,
        },
      ];

      const store = createMockStore({
        readTransactionsInPeriod: async () => txns,
        findExchangeRate: async (_c, _w, from, to) =>
          from === 'EUR' && to === 'USD' ? '2.0' : '1.0',
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.WEEKDAY_HEATMAP,
        from: '2026-01-01',
        to: '2026-01-31',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 1. Outcome and shape
      expect(res.analytics.metric).toBe(ADVANCED_METRIC.WEEKDAY_HEATMAP);
      expect(Object.keys(res.analytics.data).sort()).toEqual(['series']);
      const series = res.analytics.data.series;
      expect(Array.isArray(series)).toBe(true);
      if (!Array.isArray(series)) return;
      expect(series).toHaveLength(7);
      for (const point of series) {
        expect(Object.keys(point).sort()).toEqual([
          'totalMinor',
          'transactionCount',
          'weekday',
        ]);
      }
      expect(series[0]).toEqual({
        weekday: 1,
        transactionCount: 2,
        totalMinor: '8000',
      });
      expect(series[1]).toEqual({
        weekday: 2,
        transactionCount: 1,
        totalMinor: '15000',
      });
      expect(series[2]).toEqual({
        weekday: 3,
        transactionCount: 1,
        totalMinor: '20000',
      });
      expect(series[3]).toEqual({
        weekday: 4,
        transactionCount: 0,
        totalMinor: '0',
      });
      expect(series[4]).toEqual({
        weekday: 5,
        transactionCount: 0,
        totalMinor: '0',
      });
      expect(series[5]).toEqual({
        weekday: 6,
        transactionCount: 0,
        totalMinor: '0',
      });
      expect(series[6]).toEqual({
        weekday: 7,
        transactionCount: 0,
        totalMinor: '0',
      });

      // 2. No bigint escapes & recursive amount string format check
      expect(() => JSON.stringify(res)).not.toThrow();
      const verifiedAmounts = assertNoBigintAndValidAmounts(res);
      expect(verifiedAmounts).toBeGreaterThan(0);

      // 3. generatedAt equals injected clock
      expect(res.analytics.generatedAt).toBe(fixedClock.toISOString());

      // 4. Non-empty explanation
      expect(typeof res.analytics.explanation).toBe('string');
      if (typeof res.analytics.explanation !== 'string') return;
      expect(res.analytics.explanation.length).toBeGreaterThan(0);
      expect(res.analytics.explanation).toBe(
        'Weekday expenditure heatmap showing transaction count and net expenses by day of the week.',
      );
    });

    it('wires subscription_price_increases end-to-end with real data, exclusion counts in explanation, serialisation and shape', async () => {
      // Hand derivation for subscription_price_increases:
      // Rows provided: 5
      // 1. Streaming Pro (EUR): 10000 -> 15000 (+50%) -> included in items
      // 2. Cloud DB (USD): 10000 -> 12000 (+20%) -> included in items
      // 3. Music Free (USD): 999 -> 999 (0%) -> counted in decreasedOrUnchangedCount
      // 4. VPN Server: EUR vs USD -> counted in excludedForCurrencyMismatch
      // 5. Trial Tier: previous 0 -> counted in excludedForZeroPrevious
      //
      // Expected counts:
      // consideredCount = 5
      // decreasedOrUnchangedCount = 1
      // excludedForCurrencyMismatch = 1
      // excludedForZeroPrevious = 1
      //
      // Items sorted by increasePercent descending:
      // items[0]: Streaming Pro (+50%)
      // items[1]: Cloud DB (+20%)
      //
      // Explanation surfaces both non-zero exclusion counts:
      // "1 subscription(s) excluded due to currency mismatch"
      // "1 subscription(s) excluded due to zero previous amount"
      const subRows: SubscriptionPriceRow[] = [
        {
          id: 's-inc-2',
          payeeName: 'Streaming Pro',
          currentAmountMinor: '15000',
          currentCurrency: 'EUR',
          previousAmountMinor: '10000',
          previousCurrency: 'EUR',
        },
        {
          id: 's-inc-1',
          payeeName: 'Cloud DB',
          currentAmountMinor: '12000',
          currentCurrency: 'USD',
          previousAmountMinor: '10000',
          previousCurrency: 'USD',
        },
        {
          id: 's-same',
          payeeName: 'Music Free',
          currentAmountMinor: '999',
          currentCurrency: 'USD',
          previousAmountMinor: '999',
          previousCurrency: 'USD',
        },
        {
          id: 's-mismatch',
          payeeName: 'VPN Server',
          currentAmountMinor: '3000',
          currentCurrency: 'EUR',
          previousAmountMinor: '3000',
          previousCurrency: 'USD',
        },
        {
          id: 's-zero',
          payeeName: 'Trial Tier',
          currentAmountMinor: '1000',
          currentCurrency: 'USD',
          previousAmountMinor: '0',
          previousCurrency: 'USD',
        },
      ];

      const store = createMockStore({
        readSubscriptionsWithPreviousAmount: async () => subRows,
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.SUBSCRIPTION_PRICE_INCREASES,
        from: '2026-01-01',
        to: '2026-01-31',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 1. Outcome and shape
      expect(res.analytics.metric).toBe(
        ADVANCED_METRIC.SUBSCRIPTION_PRICE_INCREASES,
      );
      expect(Object.keys(res.analytics.data).sort()).toEqual([
        'consideredCount',
        'decreasedOrUnchangedCount',
        'excludedForCurrencyMismatch',
        'excludedForZeroPrevious',
        'items',
      ]);
      expect(res.analytics.data.consideredCount).toBe(5);
      expect(res.analytics.data.decreasedOrUnchangedCount).toBe(1);
      expect(res.analytics.data.excludedForCurrencyMismatch).toBe(1);
      expect(res.analytics.data.excludedForZeroPrevious).toBe(1);

      const items = res.analytics.data.items;
      expect(Array.isArray(items)).toBe(true);
      if (!Array.isArray(items)) return;
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([
          'currentAmount',
          'increasePercent',
          'payeeName',
          'previousAmount',
          'subscriptionId',
        ]);
        expect(Object.keys(item.previousAmount).sort()).toEqual([
          'amountMinor',
          'currency',
        ]);
        expect(Object.keys(item.currentAmount).sort()).toEqual([
          'amountMinor',
          'currency',
        ]);
      }
      expect(items[0]).toEqual({
        subscriptionId: 's-inc-2',
        payeeName: 'Streaming Pro',
        previousAmount: { amountMinor: '10000', currency: 'EUR' },
        currentAmount: { amountMinor: '15000', currency: 'EUR' },
        increasePercent: 50,
      });
      expect(items[1]).toEqual({
        subscriptionId: 's-inc-1',
        payeeName: 'Cloud DB',
        previousAmount: { amountMinor: '10000', currency: 'USD' },
        currentAmount: { amountMinor: '12000', currency: 'USD' },
        increasePercent: 20,
      });

      // 2. No bigint escapes & recursive amount string format check
      expect(() => JSON.stringify(res)).not.toThrow();
      const verifiedAmounts = assertNoBigintAndValidAmounts(res);
      expect(verifiedAmounts).toBeGreaterThan(0);

      // 3. generatedAt equals injected clock
      expect(res.analytics.generatedAt).toBe(fixedClock.toISOString());

      // 4. Non-empty explanation mentioning exclusion counts
      expect(typeof res.analytics.explanation).toBe('string');
      if (typeof res.analytics.explanation !== 'string') return;
      expect(res.analytics.explanation.length).toBeGreaterThan(0);
      expect(res.analytics.explanation).toContain(
        '1 subscription(s) excluded due to currency mismatch',
      );
      expect(res.analytics.explanation).toContain(
        '1 subscription(s) excluded due to zero previous amount',
      );
      expect(res.analytics.explanation).toBe(
        'Detected price increases across active subscriptions. Caveat: 1 subscription(s) excluded due to currency mismatch; 1 subscription(s) excluded due to zero previous amount.',
      );
    });

    it('wires debt_cost_evolution end-to-end with real payment costs, currency conversion, serialisation and explanation', async () => {
      // Hand derivation for debt_cost_evolution:
      // Period: 2026-01-01 to 2026-02-28 (2 monthly buckets: 2026-01-01 and 2026-02-01).
      // Base currency: USD. Rate EUR->USD = 1.5.
      // Month 2026-01-01:
      //   interestMinor = USD 15000 = 15000
      //   feeMinor = USD 2500 = 2500
      //   totalCostMinor = 15000 + 2500 = 17500
      // Month 2026-02-01:
      //   interestMinor = EUR 10000 * 1.5 = 15000
      //   feeMinor = EUR 1000 * 1.5 = 1500
      //   totalCostMinor = 15000 + 1500 = 16500
      // Overall totals:
      //   totalInterestMinor = 15000 + 15000 = 30000
      //   totalFeeMinor = 2500 + 1500 = 4000
      //   totalCostMinor = 30000 + 4000 = 34000
      const debtCostRows: DebtPaymentCostRow[] = [
        {
          interestMinor: '15000',
          feeMinor: '2500',
          currency: 'USD',
          occurredAt: new Date('2026-01-15T12:00:00Z'),
        },
        {
          interestMinor: '10000',
          feeMinor: '1000',
          currency: 'EUR',
          occurredAt: new Date('2026-02-10T12:00:00Z'),
        },
      ];

      const store = createMockStore({
        readDebtPaymentCostsInPeriod: async () => debtCostRows,
        findExchangeRate: async (_c, _w, from, to) =>
          from === 'EUR' && to === 'USD' ? '1.5' : '1.0',
      });
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      const res = await service.getAdvancedAnalytics(subject, {
        workspaceId,
        metric: ADVANCED_METRIC.DEBT_COST_EVOLUTION,
        from: '2026-01-01',
        to: '2026-02-28',
      });

      expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
      if (res.kind !== ANALYTICS_OUTCOMES.OK) return;

      // 1. Outcome and shape
      expect(res.analytics.metric).toBe(ADVANCED_METRIC.DEBT_COST_EVOLUTION);
      expect(Object.keys(res.analytics.data).sort()).toEqual([
        'series',
        'totalCostMinor',
        'totalFeeMinor',
        'totalInterestMinor',
      ]);
      expect(res.analytics.data.totalInterestMinor).toBe('30000');
      expect(res.analytics.data.totalFeeMinor).toBe('4000');
      expect(res.analytics.data.totalCostMinor).toBe('34000');

      const series = res.analytics.data.series;
      expect(Array.isArray(series)).toBe(true);
      if (!Array.isArray(series)) return;
      expect(series).toHaveLength(2);
      for (const point of series) {
        expect(Object.keys(point).sort()).toEqual([
          'feeMinor',
          'interestMinor',
          'month',
          'totalCostMinor',
        ]);
      }
      expect(series[0]).toEqual({
        month: '2026-01-01',
        interestMinor: '15000',
        feeMinor: '2500',
        totalCostMinor: '17500',
      });
      expect(series[1]).toEqual({
        month: '2026-02-01',
        interestMinor: '15000',
        feeMinor: '1500',
        totalCostMinor: '16500',
      });

      // 2. No bigint escapes & recursive amount string format check
      expect(() => JSON.stringify(res)).not.toThrow();
      const verifiedAmounts = assertNoBigintAndValidAmounts(res);
      expect(verifiedAmounts).toBeGreaterThan(0);

      // 3. generatedAt equals injected clock
      expect(res.analytics.generatedAt).toBe(fixedClock.toISOString());

      // 4. Non-empty explanation
      expect(typeof res.analytics.explanation).toBe('string');
      if (typeof res.analytics.explanation !== 'string') return;
      expect(res.analytics.explanation.length).toBeGreaterThan(0);
      expect(res.analytics.explanation).toBe(
        'Monthly evolution of debt interest and fee costs across the period.',
      );
    });
    it('successfully computes all nine metrics', async () => {
      const store = createMockStore();
      const service = new AnalyticsService(fakeTx, store, () => fixedClock);
      for (const metric of Object.values(ADVANCED_METRIC)) {
        const res = await service.getAdvancedAnalytics(subject, {
          workspaceId,
          metric,
          from: '2026-01-01',
          to: '2026-03-31',
        });
        expect(res.kind).toBe(ANALYTICS_OUTCOMES.OK);
        const ok = res as AdvancedAnalyticsOkOutcome;
        expect(ok.analytics.metric).toBe(metric);
        expect(ok.analytics.data).toBeDefined();
        expect(typeof ok.analytics.data).toBe('object');
        expect(ok.analytics.generatedAt).toBe('2026-09-04T12:00:00.000Z');
      }
    });
  });
});

describe('generateBucketPeriods', () => {
  it('generates day buckets', () => {
    const buckets = generateBucketPeriods('2026-01-01', '2026-01-03', 'day');
    expect(buckets).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('generates month buckets', () => {
    const buckets = generateBucketPeriods('2026-01-15', '2026-03-20', 'month');
    expect(buckets).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('generates quarter buckets', () => {
    const buckets = generateBucketPeriods(
      '2026-01-15',
      '2026-07-20',
      'quarter',
    );
    expect(buckets).toEqual(['2026-01-01', '2026-04-01', '2026-07-01']);
  });

  it('generates week buckets aligned to Monday', () => {
    // 2026-01-01 is a Thursday -> Monday of that week is 2026-12-29
    // Wait: 2026-01-01: Thursday. Monday is 2025-12-29.
    const buckets = generateBucketPeriods('2026-01-05', '2026-01-19', 'week');
    // 2026-01-05 is Monday, 2026-01-12 is Monday, 2026-01-19 is Monday
    expect(buckets).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });
});
