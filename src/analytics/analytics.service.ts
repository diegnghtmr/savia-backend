import { multiplyMinorByRate } from '../platform/currency-conversion.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  ANALYTICS_OUTCOMES,
  GRANULARITY,
  type AnalyticsPort,
  type AnalyticsStore,
  type AnalyticsSummaryOutcome,
  type AnalyticsSummaryQuery,
  type CashFlowAnalyticsOutcome,
  type CashFlowAnalyticsQuery,
  type CategoryBreakdownItem,
  type Granularity,
  type TimeSeriesPoint,
} from './analytics.port.js';

export interface AnalyticsTransactionRunner {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

/**
 * Truncates a UTC Date to its bucket start date string (YYYY-MM-DD).
 */
export function truncateToBucketStart(
  date: Date,
  granularity: Granularity,
): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  switch (granularity) {
    case GRANULARITY.DAY:
      return date.toISOString().slice(0, 10);
    case GRANULARITY.WEEK: {
      // ISO week starts on Monday
      const dayOfWeek = date.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
      const diffToMonday = (dayOfWeek + 6) % 7;
      const monday = new Date(Date.UTC(year, month, day - diffToMonday));
      return monday.toISOString().slice(0, 10);
    }
    case GRANULARITY.MONTH: {
      const monthStart = new Date(Date.UTC(year, month, 1));
      return monthStart.toISOString().slice(0, 10);
    }
    case GRANULARITY.QUARTER: {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      const quarterStart = new Date(Date.UTC(year, quarterStartMonth, 1));
      return quarterStart.toISOString().slice(0, 10);
    }
  }
}

/**
 * Generates an inclusive, gap-free list of bucket start dates (YYYY-MM-DD) in UTC.
 */
export function generateBucketPeriods(
  fromStr: string,
  toStr: string,
  granularity: Granularity,
): string[] {
  const fromDate = new Date(`${fromStr}T00:00:00.000Z`);
  const toDate = new Date(`${toStr}T00:00:00.000Z`);

  const startBucket = truncateToBucketStart(fromDate, granularity);
  const endBucket = truncateToBucketStart(toDate, granularity);

  const periods: string[] = [];
  let current = new Date(`${startBucket}T00:00:00.000Z`);
  const end = new Date(`${endBucket}T00:00:00.000Z`);

  while (current.getTime() <= end.getTime()) {
    const periodStr = current.toISOString().slice(0, 10);
    periods.push(periodStr);

    const curYear = current.getUTCFullYear();
    const curMonth = current.getUTCMonth();
    const curDay = current.getUTCDate();

    switch (granularity) {
      case GRANULARITY.DAY:
        current = new Date(Date.UTC(curYear, curMonth, curDay + 1));
        break;
      case GRANULARITY.WEEK:
        current = new Date(Date.UTC(curYear, curMonth, curDay + 7));
        break;
      case GRANULARITY.MONTH:
        current = new Date(Date.UTC(curYear, curMonth + 1, 1));
        break;
      case GRANULARITY.QUARTER:
        current = new Date(Date.UTC(curYear, curMonth + 3, 1));
        break;
    }
  }

  return periods;
}

export class AnalyticsService implements AnalyticsPort {
  public constructor(
    private readonly tx: AnalyticsTransactionRunner,
    private readonly store: AnalyticsStore,
  ) {}

  public async getSummary(
    subject: string,
    query: AnalyticsSummaryQuery,
  ): Promise<AnalyticsSummaryOutcome> {
    return this.tx.run(subject, async (client) => {
      // 6. Authorization: 401 handled by guard; 403 for non-member. Viewer MAY read.
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };
      }

      // 5. Presentation currency: when absent, report in the workspace's base currency
      const baseCurrency = await this.store.readWorkspaceBaseCurrency(
        client,
        query.workspaceId,
      );
      if (!baseCurrency) {
        return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };
      }

      const targetCurrency = query.presentationCurrency ?? baseCurrency;

      // Helper to convert money amounts
      const convert = async (
        amountMinor: string,
        fromCurrency: string,
        asOf?: Date | null,
      ): Promise<
        { amount: bigint } | { missingRate: { from: string; to: string } }
      > => {
        if (fromCurrency === targetCurrency) {
          return { amount: BigInt(amountMinor) };
        }
        const rate = await this.store.findExchangeRate(
          client,
          query.workspaceId,
          fromCurrency,
          targetCurrency,
          asOf,
        );
        if (!rate) {
          return { missingRate: { from: fromCurrency, to: targetCurrency } };
        }
        return { amount: BigInt(multiplyMinorByRate(amountMinor, rate)) };
      };

      // 4.4 Assets: sum of account native balances across the workspace's non-closed accounts
      const accountRows = await this.store.readAccountNativeBalances(
        client,
        query.workspaceId,
      );
      let totalAssets = 0n;
      for (const acct of accountRows) {
        const converted = await convert(acct.nativeBalanceMinor, acct.currency);
        if ('missingRate' in converted) {
          return {
            kind: ANALYTICS_OUTCOMES.MISSING_RATE,
            fromCurrency: converted.missingRate.from,
            toCurrency: converted.missingRate.to,
          };
        }
        totalAssets += converted.amount;
      }

      // 4.4 Debts: sum of outstanding balances of non-archived debts (principal minus confirmed principal payments, clamped at zero)
      const debtRows = await this.store.readDebtOutstandingBalances(
        client,
        query.workspaceId,
      );
      let totalDebts = 0n;
      for (const debt of debtRows) {
        const converted = await convert(
          debt.outstandingBalanceMinor,
          debt.currency,
        );
        if ('missingRate' in converted) {
          return {
            kind: ANALYTICS_OUTCOMES.MISSING_RATE,
            fromCurrency: converted.missingRate.from,
            toCurrency: converted.missingRate.to,
          };
        }
        totalDebts += converted.amount;
      }

      // 4.4 netWorth = assets - debts
      const netWorthMinor = totalAssets - totalDebts;

      // 4.1 Period: evaluated in UTC, inclusive on both ends
      // 4.2 income and expenses:
      // Classify by transaction type:
      // income = sum of transactions with type = 'income'
      // expenses = sum of transactions with type = 'expense' MINUS those with type = 'refund'
      // EXCLUDED from both: adjustment, debt_payment, fund_contribution
      // EXCLUDED entirely: transfers (transfer postings carry a non-null transfer_id)
      // expenses is reported as a POSITIVE magnitude even though the underlying postings are negative.
      const txnRows = await this.store.readTransactionsInPeriod(
        client,
        query.workspaceId,
        query.from,
        query.to,
      );

      let totalIncome = 0n;
      let totalExpenses = 0n;

      for (const txn of txnRows) {
        const converted = await convert(
          txn.amountMinor,
          txn.currency,
          txn.occurredAt,
        );
        if ('missingRate' in converted) {
          return {
            kind: ANALYTICS_OUTCOMES.MISSING_RATE,
            fromCurrency: converted.missingRate.from,
            toCurrency: converted.missingRate.to,
          };
        }
        if (txn.type === 'income') {
          totalIncome += converted.amount;
        } else if (txn.type === 'expense') {
          totalExpenses += converted.amount;
        } else if (txn.type === 'refund') {
          totalExpenses -= converted.amount;
        }
      }

      // 4.3 savingsCapacity = income - expenses. It may be negative; report it as-is. Never clamp.
      const savingsCapacityMinor = totalIncome - totalExpenses;

      // 4.5 budgetUtilizationPercent: across workspace's budgets whose period overlaps [from, to],
      // 100 * (total actual) / (total planned), using buildCategorySpendSql.
      // If total planned is zero, OMIT the field entirely.
      const allocations = await this.store.readOverlappingBudgetAllocations(
        client,
        query.workspaceId,
        query.from,
        query.to,
      );

      let totalPlanned = 0n;
      for (const alloc of allocations) {
        const converted = await convert(alloc.plannedMinor, alloc.currency);
        if ('missingRate' in converted) {
          return {
            kind: ANALYTICS_OUTCOMES.MISSING_RATE,
            fromCurrency: converted.missingRate.from,
            toCurrency: converted.missingRate.to,
          };
        }
        totalPlanned += converted.amount;
      }

      let budgetUtilizationPercent: number | undefined;
      if (totalPlanned > 0n) {
        const spends = await this.store.readOverlappingBudgetSpend(
          client,
          query.workspaceId,
          query.from,
          query.to,
        );
        let totalActual = 0n;
        for (const spend of spends) {
          const converted = await convert(
            spend.amountMinor,
            spend.postingCurrency,
            spend.occurredAt,
          );
          if ('missingRate' in converted) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: converted.missingRate.from,
              toCurrency: converted.missingRate.to,
            };
          }
          totalActual += converted.amount;
        }
        budgetUtilizationPercent =
          (Number(totalActual) / Number(totalPlanned)) * 100;
      }

      return {
        kind: ANALYTICS_OUTCOMES.OK,
        summary: {
          periodStart: query.from,
          periodEnd: query.to,
          baseCurrency: targetCurrency,
          netWorth: {
            amountMinor: netWorthMinor.toString(),
            currency: targetCurrency,
          },
          assets: {
            amountMinor: totalAssets.toString(),
            currency: targetCurrency,
          },
          debts: {
            amountMinor: totalDebts.toString(),
            currency: targetCurrency,
          },
          income: {
            amountMinor: totalIncome.toString(),
            currency: targetCurrency,
          },
          expenses: {
            amountMinor: totalExpenses.toString(),
            currency: targetCurrency,
          },
          savingsCapacity: {
            amountMinor: savingsCapacityMinor.toString(),
            currency: targetCurrency,
          },
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
    return this.tx.run(subject, async (client) => {
      // 6. Authorization check
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };
      }

      const baseCurrency = await this.store.readWorkspaceBaseCurrency(
        client,
        query.workspaceId,
      );
      if (!baseCurrency) {
        return { kind: ANALYTICS_OUTCOMES.FORBIDDEN };
      }

      const txnRows = await this.store.readTransactionsInPeriod(
        client,
        query.workspaceId,
        query.from,
        query.to,
      );

      // Convert all transactions to workspace base currency
      interface ConvertedTxn {
        readonly type: string;
        readonly amount: bigint;
        readonly occurredAt: Date;
        readonly categoryId: string | null;
        readonly categoryName: string | null;
      }

      const convertedTxns: ConvertedTxn[] = [];
      for (const txn of txnRows) {
        let amount: bigint;
        if (txn.currency === baseCurrency) {
          amount = BigInt(txn.amountMinor);
        } else {
          const rate = await this.store.findExchangeRate(
            client,
            query.workspaceId,
            txn.currency,
            baseCurrency,
            txn.occurredAt,
          );
          if (!rate) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: txn.currency,
              toCurrency: baseCurrency,
            };
          }
          amount = BigInt(multiplyMinorByRate(txn.amountMinor, rate));
        }
        convertedTxns.push({
          type: txn.type,
          amount,
          occurredAt: txn.occurredAt,
          categoryId: txn.categoryId,
          categoryName: txn.categoryName,
        });
      }

      // 4.6 Cash flow series:
      // Buckets the period in UTC.
      // TimeSeriesPoint.period is bucket's start date as YYYY-MM-DD.
      // value is net flow for the bucket (income - expenses, per 4.2).
      // secondaryValue is cumulative running total through that bucket.
      // Gap-free series: empty buckets appear with zero values.
      const bucketPeriods = generateBucketPeriods(
        query.from,
        query.to,
        query.granularity,
      );

      // Map bucket period -> net flow
      const bucketFlows = new Map<string, bigint>();
      for (const p of bucketPeriods) {
        bucketFlows.set(p, 0n);
      }

      for (const txn of convertedTxns) {
        const bucketPeriod = truncateToBucketStart(
          txn.occurredAt,
          query.granularity,
        );
        if (bucketFlows.has(bucketPeriod)) {
          const current = bucketFlows.get(bucketPeriod)!;
          if (txn.type === 'income') {
            bucketFlows.set(bucketPeriod, current + txn.amount);
          } else if (txn.type === 'expense') {
            bucketFlows.set(bucketPeriod, current - txn.amount);
          } else if (txn.type === 'refund') {
            bucketFlows.set(bucketPeriod, current + txn.amount);
          }
        }
      }

      let runningTotal = 0n;
      const series: TimeSeriesPoint[] = [];

      for (const period of bucketPeriods) {
        const netFlow = bucketFlows.get(period) ?? 0n;
        runningTotal += netFlow;
        series.push({
          period,
          value: {
            amountMinor: netFlow.toString(),
            currency: baseCurrency,
          },
          secondaryValue: {
            amountMinor: runningTotal.toString(),
            currency: baseCurrency,
          },
        });
      }

      // 4.7 categories breakdown:
      // CategoryBreakdownItem per category over period: amount is expense magnitude,
      // percentage is 100 * amount / total expenses as a number.
      // If total expenses is zero, return an EMPTY array — do not emit items with percentage 0/0.
      // Uncategorised transactions are grouped under no category and therefore excluded from this array.
      let totalWorkspaceExpenses = 0n;
      for (const txn of convertedTxns) {
        if (txn.type === 'expense') {
          totalWorkspaceExpenses += txn.amount;
        } else if (txn.type === 'refund') {
          totalWorkspaceExpenses -= txn.amount;
        }
      }

      const categories: CategoryBreakdownItem[] = [];
      if (totalWorkspaceExpenses > 0n) {
        const categoryMap = new Map<
          string,
          { categoryId: string; categoryName: string; amount: bigint }
        >();

        for (const txn of convertedTxns) {
          // Uncategorised transactions (categoryId === null) are excluded per 4.7
          if (!txn.categoryId || !txn.categoryName) continue;

          let entry = categoryMap.get(txn.categoryId);
          if (!entry) {
            entry = {
              categoryId: txn.categoryId,
              categoryName: txn.categoryName,
              amount: 0n,
            };
            categoryMap.set(txn.categoryId, entry);
          }

          if (txn.type === 'expense') {
            entry.amount += txn.amount;
          } else if (txn.type === 'refund') {
            entry.amount -= txn.amount;
          }
        }

        for (const cat of categoryMap.values()) {
          if (cat.amount > 0n) {
            const percentage =
              (Number(cat.amount) / Number(totalWorkspaceExpenses)) * 100;
            categories.push({
              categoryId: cat.categoryId,
              categoryName: cat.categoryName,
              amount: {
                amountMinor: cat.amount.toString(),
                currency: baseCurrency,
              },
              percentage,
            });
          }
        }

        // Deterministic ordering: descending amount, ascending categoryName
        categories.sort(
          (a, b) =>
            Number(
              BigInt(b.amount.amountMinor) - BigInt(a.amount.amountMinor),
            ) || a.categoryName.localeCompare(b.categoryName),
        );
      }

      return {
        kind: ANALYTICS_OUTCOMES.OK,
        analytics: {
          series,
          categories,
        },
      };
    });
  }
}
