import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_OUTCOMES,
  type AnalyticsStore,
  type TransactionFlowRow,
  type AccountNativeBalanceRow,
  type DebtOutstandingBalanceRow,
} from '../../src/analytics/analytics.port.js';
import {
  AnalyticsService,
  generateBucketPeriods,
} from '../../src/analytics/analytics.service.js';

describe('AnalyticsService', () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const subject = '00000000-0000-4000-8000-000000000099';

  const fakeTx = {
    run: async <T>(_sub: string, cb: (client: any) => Promise<T>): Promise<T> => {
      return cb({});
    },
  };

  const createMockStore = (overrides: Partial<AnalyticsStore> = {}): AnalyticsStore => ({
    readActiveRole: async () => 'owner',
    readWorkspaceBaseCurrency: async () => 'USD',
    readAccountNativeBalances: async () => [],
    readDebtOutstandingBalances: async () => [],
    readTransactionsInPeriod: async () => [],
    readOverlappingBudgetAllocations: async () => [],
    readOverlappingBudgetSpend: async () => [],
    findExchangeRate: async () => '1.0',
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
    const buckets = generateBucketPeriods('2026-01-15', '2026-07-20', 'quarter');
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
