import { multiplyMinorByRate } from '../platform/currency-conversion.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  ADVANCED_METRIC,
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
  type ConvertedDebtCostRow,
  type ConvertedFlowRow,
  type ConvertedSubscriptionRow,
  type ScheduledOutflowRow,
  type TimeSeriesPoint,
} from './analytics.port.js';
import {
  buildBalanceProjection,
  buildDebtCostEvolution,
  buildFinancialCalendar,
  buildIncomeStability,
  buildMonthlySavingsCapacity,
  buildQuarterlyAverageComparison,
  buildRecurringVsVariable,
  buildSubscriptionPriceIncreases,
  buildWeekdayHeatmap,
  generateBucketPeriods,
  truncateToBucketStart,
} from './advanced-metrics.js';

export { generateBucketPeriods, truncateToBucketStart };

export interface AnalyticsTransactionRunner {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

function serializeData(val: unknown): unknown {
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (Array.isArray(val)) {
    return val.map(serializeData);
  }
  if (val !== null && typeof val === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(val)) {
      result[key] = serializeData(value);
    }
    return result;
  }
  return val;
}

export class AnalyticsService implements AnalyticsPort {
  public constructor(
    private readonly tx: AnalyticsTransactionRunner,
    private readonly store: AnalyticsStore,
    private readonly clock: () => Date = () => new Date(),
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
      // expenses is the NET of expense minus refund, expressed with money-out positive.
      // It is legitimately NEGATIVE when refunds exceed expenses in the period. Do NOT
      // "fix" this by clamping: savingsCapacity = income - expenses depends on the true net.
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
      // percentage is 100 * amount / total expenses as a number. The denominator is
      // total expenses INCLUDING uncategorised spending because uncategorised spending
      // is real spending even though it has no category row to appear in the response.
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

  public async getAdvancedAnalytics(
    subject: string,
    query: AdvancedAnalyticsQuery,
  ): Promise<AdvancedAnalyticsOutcome> {
    return this.tx.run(subject, async (client) => {
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

      const convert = async (
        amountMinor: string,
        fromCurrency: string,
        asOf?: Date | null,
      ): Promise<
        { amount: bigint } | { missingRate: { from: string; to: string } }
      > => {
        if (fromCurrency === baseCurrency) {
          return { amount: BigInt(amountMinor) };
        }
        const rate = await this.store.findExchangeRate(
          client,
          query.workspaceId,
          fromCurrency,
          baseCurrency,
          asOf,
        );
        if (!rate) {
          return { missingRate: { from: fromCurrency, to: baseCurrency } };
        }
        return { amount: BigInt(multiplyMinorByRate(amountMinor, rate)) };
      };

      const loadConvertedFlowRows = async (): Promise<
        ConvertedFlowRow[] | { missingRate: { from: string; to: string } }
      > => {
        const txnRows = await this.store.readTransactionsInPeriod(
          client,
          query.workspaceId,
          query.from,
          query.to,
        );
        const convertedRows: ConvertedFlowRow[] = [];
        for (const txn of txnRows) {
          if (
            txn.type === 'income' ||
            txn.type === 'expense' ||
            txn.type === 'refund'
          ) {
            const converted = await convert(
              txn.amountMinor,
              txn.currency,
              txn.occurredAt,
            );
            if ('missingRate' in converted) {
              return converted;
            }
            convertedRows.push({
              type: txn.type,
              amountMinor: converted.amount,
              occurredAt: txn.occurredAt,
            });
          }
        }
        return convertedRows;
      };

      let rawData: unknown = undefined;
      let explanation: string | null = null;

      switch (query.metric) {
        case ADVANCED_METRIC.MONTHLY_SAVINGS_CAPACITY: {
          const flowRows = await loadConvertedFlowRows();
          if ('missingRate' in flowRows) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: flowRows.missingRate.from,
              toCurrency: flowRows.missingRate.to,
            };
          }
          const points = buildMonthlySavingsCapacity(
            query.from,
            query.to,
            flowRows,
          );
          rawData = { series: points };
          explanation = 'Monthly savings capacity series over the period.';
          break;
        }

        case ADVANCED_METRIC.INCOME_STABILITY: {
          const flowRows = await loadConvertedFlowRows();
          if ('missingRate' in flowRows) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: flowRows.missingRate.from,
              toCurrency: flowRows.missingRate.to,
            };
          }
          const monthlySeries = buildMonthlySavingsCapacity(
            query.from,
            query.to,
            flowRows,
          );
          const stability = buildIncomeStability(monthlySeries);
          rawData = stability;
          explanation = `Income stability analysis over ${stability.monthsCounted} month(s) based on monthly income variation.`;
          break;
        }

        case ADVANCED_METRIC.QUARTERLY_AVERAGE_COMPARISON: {
          const flowRows = await loadConvertedFlowRows();
          if ('missingRate' in flowRows) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: flowRows.missingRate.from,
              toCurrency: flowRows.missingRate.to,
            };
          }
          const monthlySeries = buildMonthlySavingsCapacity(
            query.from,
            query.to,
            flowRows,
          );
          const quarters = buildQuarterlyAverageComparison(monthlySeries);
          rawData = { series: quarters };
          explanation =
            'Quarterly average monthly income, expenses, and savings capacity comparison.';
          break;
        }

        case ADVANCED_METRIC.WEEKDAY_HEATMAP: {
          const flowRows = await loadConvertedFlowRows();
          if ('missingRate' in flowRows) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: flowRows.missingRate.from,
              toCurrency: flowRows.missingRate.to,
            };
          }
          const heatmap = buildWeekdayHeatmap(flowRows);
          rawData = { series: heatmap };
          explanation =
            'Weekday expenditure heatmap showing transaction count and net expenses by day of the week.';
          break;
        }

        case ADVANCED_METRIC.SUBSCRIPTION_PRICE_INCREASES: {
          const rows = await this.store.readSubscriptionsWithPreviousAmount(
            client,
            query.workspaceId,
          );
          const result = buildSubscriptionPriceIncreases(rows);
          rawData = result;
          const caveats: string[] = [];
          if (result.excludedForCurrencyMismatch > 0) {
            caveats.push(
              `${result.excludedForCurrencyMismatch} subscription(s) excluded due to currency mismatch`,
            );
          }
          if (result.excludedForZeroPrevious > 0) {
            caveats.push(
              `${result.excludedForZeroPrevious} subscription(s) excluded due to zero previous amount`,
            );
          }
          explanation = 'Detected price increases across active subscriptions.';
          if (caveats.length > 0) {
            explanation += ` Caveat: ${caveats.join('; ')}.`;
          }
          break;
        }

        case ADVANCED_METRIC.RECURRING_VS_VARIABLE: {
          const subs = await this.store.readActiveSubscriptions(
            client,
            query.workspaceId,
          );
          const txnRows = await this.store.readTransactionsInPeriod(
            client,
            query.workspaceId,
            query.from,
            query.to,
          );
          let totalExpensesMinor = 0n;
          for (const txn of txnRows) {
            if (txn.type === 'expense') {
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
              totalExpensesMinor += converted.amount;
            } else if (txn.type === 'refund') {
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
              totalExpensesMinor -= converted.amount;
            }
          }

          const convertedSubs: ConvertedSubscriptionRow[] = [];
          for (const sub of subs) {
            const converted = await convert(
              sub.currentAmountMinor,
              sub.currentCurrency,
            );
            if ('missingRate' in converted) {
              return {
                kind: ANALYTICS_OUTCOMES.MISSING_RATE,
                fromCurrency: converted.missingRate.from,
                toCurrency: converted.missingRate.to,
              };
            }
            convertedSubs.push({
              amountMinor: converted.amount,
              frequency: sub.frequency,
            });
          }

          const result = buildRecurringVsVariable(
            query.from,
            query.to,
            convertedSubs,
            totalExpensesMinor,
          );
          rawData = result;
          explanation =
            'Comparison of committed recurring expenses against variable expenses over the period.';
          if (result.unclassifiedSubscriptionCount > 0) {
            explanation += ` Caveat: ${result.unclassifiedSubscriptionCount} subscription(s) could not be classified due to unrecognized frequency.`;
          }
          break;
        }

        case ADVANCED_METRIC.DEBT_COST_EVOLUTION: {
          const rows = await this.store.readDebtPaymentCostsInPeriod(
            client,
            query.workspaceId,
            query.from,
            query.to,
          );
          const convertedRows: ConvertedDebtCostRow[] = [];
          for (const row of rows) {
            const intConv = await convert(
              row.interestMinor,
              row.currency,
              row.occurredAt,
            );
            if ('missingRate' in intConv) {
              return {
                kind: ANALYTICS_OUTCOMES.MISSING_RATE,
                fromCurrency: intConv.missingRate.from,
                toCurrency: intConv.missingRate.to,
              };
            }
            const feeConv = await convert(
              row.feeMinor,
              row.currency,
              row.occurredAt,
            );
            if ('missingRate' in feeConv) {
              return {
                kind: ANALYTICS_OUTCOMES.MISSING_RATE,
                fromCurrency: feeConv.missingRate.from,
                toCurrency: feeConv.missingRate.to,
              };
            }
            convertedRows.push({
              interestMinor: intConv.amount,
              feeMinor: feeConv.amount,
              occurredAt: row.occurredAt,
            });
          }
          const result = buildDebtCostEvolution(
            query.from,
            query.to,
            convertedRows,
          );
          rawData = result;
          explanation =
            'Monthly evolution of debt interest and fee costs across the period.';
          break;
        }

        case ADVANCED_METRIC.FINANCIAL_CALENDAR: {
          const outflows = await this.store.readScheduledOutflows(
            client,
            query.workspaceId,
            query.from,
            query.to,
          );
          const debtsWithoutScheduledAmount =
            await this.store.readActiveDebtsWithoutScheduledAmount(
              client,
              query.workspaceId,
            );

          const convertedOutflows: ScheduledOutflowRow[] = [];
          for (const row of outflows) {
            let rowDate: Date | null = null;
            if (row.scheduledDate) {
              rowDate = new Date(`${row.scheduledDate}T00:00:00.000Z`);
            } else if (row.scheduledAt) {
              rowDate = row.scheduledAt;
            }

            if (row.kind === 'recurring_rule' && row.template) {
              const tmplAmount = row.template.amount;
              if (
                tmplAmount?.currency &&
                tmplAmount?.amountMinor &&
                /^-?[0-9]+$/.test(tmplAmount.amountMinor)
              ) {
                const conv = await convert(
                  tmplAmount.amountMinor,
                  tmplAmount.currency,
                  rowDate,
                );
                if ('missingRate' in conv) {
                  return {
                    kind: ANALYTICS_OUTCOMES.MISSING_RATE,
                    fromCurrency: conv.missingRate.from,
                    toCurrency: conv.missingRate.to,
                  };
                }
                convertedOutflows.push({
                  ...row,
                  template: {
                    ...row.template,
                    amount: {
                      amountMinor: conv.amount.toString(),
                      currency: baseCurrency,
                    },
                  },
                });
              } else {
                convertedOutflows.push(row);
              }
            } else if (
              row.currency &&
              row.amountMinor !== null &&
              row.amountMinor !== undefined &&
              /^-?[0-9]+$/.test(String(row.amountMinor))
            ) {
              const conv = await convert(
                String(row.amountMinor),
                row.currency,
                rowDate,
              );
              if ('missingRate' in conv) {
                return {
                  kind: ANALYTICS_OUTCOMES.MISSING_RATE,
                  fromCurrency: conv.missingRate.from,
                  toCurrency: conv.missingRate.to,
                };
              }
              convertedOutflows.push({
                ...row,
                amountMinor: conv.amount.toString(),
                currency: baseCurrency,
              });
            } else {
              convertedOutflows.push(row);
            }
          }

          const result = buildFinancialCalendar(
            query.from,
            query.to,
            convertedOutflows,
            debtsWithoutScheduledAmount,
          );
          rawData = result;
          const caveats: string[] = [];
          if (result.debtsWithoutScheduledAmount > 0) {
            caveats.push(
              `${result.debtsWithoutScheduledAmount} active debt(s) without scheduled payment amount`,
            );
          }
          if (result.recurringRulesWithUnreadableTemplate > 0) {
            caveats.push(
              `${result.recurringRulesWithUnreadableTemplate} recurring rule(s) with unreadable template`,
            );
          }
          explanation =
            'Expected scheduled outflows by calendar day over the period.';
          if (caveats.length > 0) {
            explanation += ` Caveat: ${caveats.join('; ')}.`;
          }
          break;
        }

        case ADVANCED_METRIC.BALANCE_PROJECTION: {
          const accountRows = await this.store.readAccountNativeBalances(
            client,
            query.workspaceId,
          );
          let openingBalanceMinor = 0n;
          for (const acct of accountRows) {
            const converted = await convert(
              acct.nativeBalanceMinor,
              acct.currency,
            );
            if ('missingRate' in converted) {
              return {
                kind: ANALYTICS_OUTCOMES.MISSING_RATE,
                fromCurrency: converted.missingRate.from,
                toCurrency: converted.missingRate.to,
              };
            }
            openingBalanceMinor += converted.amount;
          }

          const flowRows = await loadConvertedFlowRows();
          if ('missingRate' in flowRows) {
            return {
              kind: ANALYTICS_OUTCOMES.MISSING_RATE,
              fromCurrency: flowRows.missingRate.from,
              toCurrency: flowRows.missingRate.to,
            };
          }
          const history = buildMonthlySavingsCapacity(
            query.from,
            query.to,
            flowRows,
          );
          const result = buildBalanceProjection(
            query.from,
            query.to,
            openingBalanceMinor,
            history,
          );
          rawData = result;
          explanation = `Extrapolation of future balances based on the historical monthly mean over basisMonths (${result.basisMonths}) month(s); this is an extrapolation, never an observation.`;
          break;
        }
      }

      const serializedData = serializeData(rawData) as Record<string, unknown>;

      return {
        kind: ANALYTICS_OUTCOMES.OK,
        analytics: {
          metric: query.metric,
          generatedAt: this.clock().toISOString(),
          data: serializedData,
          explanation,
        },
      };
    });
  }
}
