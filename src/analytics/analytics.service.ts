import {
  describeFxRate,
  FxUsage,
  multiplyMinorByRate,
} from '../platform/currency-conversion.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  ANALYTICS_OUTCOMES,
  type AdvancedAnalyticsOutcome,
  type AdvancedAnalyticsQuery,
  type AnalyticsPort,
  type AnalyticsStore,
  type AnalyticsSummaryOutcome,
  type AnalyticsSummaryQuery,
  type CashFlowAnalyticsOutcome,
  type CashFlowAnalyticsQuery,
  type CategoryBreakdownItem,
} from './analytics.port.js';
import {
  asMoney,
  generateBucketPeriods,
  truncateToBucketStart,
} from './advanced-metrics.js';
import { evaluateAdvancedAnalytics } from './advanced-analytics.js';

export { generateBucketPeriods, truncateToBucketStart };

export interface AnalyticsTransactionRunner {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class AnalyticsService implements AnalyticsPort {
  public constructor(
    private readonly tx: AnalyticsTransactionRunner,
    private readonly store: AnalyticsStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async currencyFor(
    client: TransactionClient,
    query: AnalyticsSummaryQuery,
  ): Promise<string | undefined> {
    const role = await this.store.readActiveRole(client, query.workspaceId);
    if (!['owner', 'administrator', 'editor', 'viewer'].includes(role ?? ''))
      return undefined;
    const base = await this.store.readWorkspaceBaseCurrency(
      client,
      query.workspaceId,
    );
    return base ? (query.presentationCurrency ?? base) : undefined;
  }

  public async getSummary(
    subject: string,
    query: AnalyticsSummaryQuery,
  ): Promise<AnalyticsSummaryOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const currency = await this.currencyFor(client, query);
      if (!currency) return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };

      const usage = new FxUsage();
      // Summary retains its existing FX policy. Cash flow and advanced analytics
      // use only rates effective at or before their respective valuation instants.
      const convert = async (
        amount: string,
        from: string,
        asOf?: Date,
      ): Promise<bigint | undefined> => {
        if (from === currency) return BigInt(amount);
        const rate = await this.store.findExchangeRate(
          client,
          query.workspaceId,
          from,
          currency,
          asOf,
        );
        if (!rate) return undefined;
        usage.add(describeFxRate(from, currency, rate));
        return BigInt(multiplyMinorByRate(amount, rate.rate));
      };
      const missing = (fromCurrency: string) => ({
        kind: ANALYTICS_OUTCOMES.MISSING_RATE,
        fromCurrency,
        toCurrency: currency,
      });

      const accountRows = await this.store.readAccountNativeBalances(
        client,
        query.workspaceId,
      );
      let assets = 0n;
      for (const account of accountRows) {
        const amount = await convert(
          account.nativeBalanceMinor,
          account.currency,
        );
        if (amount === undefined) return missing(account.currency);
        assets += amount;
      }

      const debtRows = await this.store.readDebtOutstandingBalances(
        client,
        query.workspaceId,
      );
      let debts = 0n;
      for (const debt of debtRows) {
        const amount = await convert(
          debt.outstandingBalanceMinor,
          debt.currency,
        );
        if (amount === undefined) return missing(debt.currency);
        debts += amount;
      }

      const movements = await this.store.readTransactionsInPeriod(
        client,
        query.workspaceId,
        query.from,
        query.to,
      );
      let income = 0n;
      let expenses = 0n;
      for (const row of movements) {
        const amount = await convert(
          row.amountMinor,
          row.currency,
          row.occurredAt,
        );
        if (amount === undefined) return missing(row.currency);
        if (row.type === 'income') income += amount;
        if (row.type === 'expense') expenses += amount;
        if (row.type === 'refund') expenses -= amount;
      }

      const allocations = await this.store.readOverlappingBudgetAllocations(
        client,
        query.workspaceId,
        query.from,
        query.to,
      );
      let planned = 0n;
      for (const allocation of allocations) {
        const amount = await convert(
          allocation.plannedMinor,
          allocation.currency,
        );
        if (amount === undefined) return missing(allocation.currency);
        planned += amount;
      }
      let budgetUtilizationPercent: number | undefined;
      if (planned > 0n) {
        const spend = await this.store.readOverlappingBudgetSpend(
          client,
          query.workspaceId,
          query.from,
          query.to,
        );
        let actual = 0n;
        for (const row of spend) {
          const amount = await convert(
            row.amountMinor,
            row.postingCurrency,
            row.occurredAt,
          );
          if (amount === undefined) return missing(row.postingCurrency);
          actual += amount;
        }
        budgetUtilizationPercent = (Number(actual) / Number(planned)) * 100;
      }
      return {
        kind: ANALYTICS_OUTCOMES.OK,
        summary: {
          periodStart: query.from,
          periodEnd: query.to,
          baseCurrency: currency,
          netWorth: asMoney(assets - debts, currency),
          assets: asMoney(assets, currency),
          debts: asMoney(debts, currency),
          income: asMoney(income, currency),
          expenses: asMoney(expenses, currency),
          savingsCapacity: asMoney(income - expenses, currency),
          ...usage.fields(),
          ...(budgetUtilizationPercent !== undefined
            ? { budgetUtilizationPercent }
            : {}),
        },
      };
    });
  }

  public async getCashFlow(
    subject: string,
    query: CashFlowAnalyticsQuery,
  ): Promise<CashFlowAnalyticsOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const currency = await this.currencyFor(client, query);
      if (!currency) return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };
      const movements = await this.store.readTransactionsInPeriod(
        client,
        query.workspaceId,
        query.from,
        query.to,
        query.filters,
      );

      // Bucket labels denote UTC calendar boundaries; amounts are clipped to
      // the inclusive requested dates and never extrapolated to a full bucket.
      const buckets = new Map(
        generateBucketPeriods(query.from, query.to, query.granularity).map(
          (date) => [date, 0n],
        ),
      );
      const byCategory = new Map<string, { name: string; amount: bigint }>();
      const usage = new FxUsage();
      let totalExpense = 0n;
      for (const row of movements) {
        let amount = BigInt(row.amountMinor);
        if (row.currency !== currency) {
          const rate = await this.store.findExchangeRate(
            client,
            query.workspaceId,
            row.currency,
            currency,
            row.occurredAt,
            true,
          );
          if (!rate)
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: row.currency,
              toCurrency: currency,
            };
          usage.add(describeFxRate(row.currency, currency, rate));
          amount = BigInt(multiplyMinorByRate(row.amountMinor, rate.rate));
        }
        const period = truncateToBucketStart(row.occurredAt, query.granularity);
        if (buckets.has(period))
          buckets.set(
            period,
            buckets.get(period)! + (row.type === 'expense' ? -amount : amount),
          );
        if (row.type !== 'expense' && row.type !== 'refund') continue;
        const netExpense = row.type === 'refund' ? -amount : amount;
        totalExpense += netExpense;
        if (row.categoryId && row.categoryName) {
          const entry = byCategory.get(row.categoryId) ?? {
            name: row.categoryName,
            amount: 0n,
          };
          entry.amount += netExpense;
          byCategory.set(row.categoryId, entry);
        }
      }
      let accumulated = 0n;
      const series = [...buckets].map(([period, amount]) => ({
        period,
        value: asMoney(amount, currency),
        secondaryValue: asMoney((accumulated += amount), currency),
      }));
      const categories: CategoryBreakdownItem[] = [];
      if (totalExpense > 0n) {
        for (const [categoryId, item] of [...byCategory].sort(
          ([aId, a], [bId, b]) =>
            (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1) ||
            a.name.localeCompare(b.name) ||
            aId.localeCompare(bId),
        )) {
          if (item.amount > 0n)
            categories.push({
              categoryId,
              categoryName: item.name,
              amount: asMoney(item.amount, currency),
              percentage: (Number(item.amount) / Number(totalExpense)) * 100,
            });
        }
      }
      return {
        kind: ANALYTICS_OUTCOMES.OK,
        analytics: { series, categories, ...usage.fields() },
      };
    });
  }

  public async getAdvancedAnalytics(
    subject: string,
    query: AdvancedAnalyticsQuery,
  ): Promise<AdvancedAnalyticsOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const currency = await this.currencyFor(client, query);
      if (!currency) return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };
      const analytics = await evaluateAdvancedAnalytics(
        this.store,
        client,
        query,
        currency,
        this.clock(),
      );
      return { kind: ANALYTICS_OUTCOMES.OK, analytics };
    });
  }
}
