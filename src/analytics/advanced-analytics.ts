import {
  describeFxRate,
  FxUsage,
  multiplyMinorByRate,
  type SelectedFxRate,
} from '../platform/currency-conversion.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  asMoney,
  buildBalanceProjection,
  buildDebtCostEvolution,
  buildDebtOutlook,
  buildFinancialCalendar,
  buildIncomeStability,
  buildMonthlySavingsCapacity,
  buildNetWorthHistory,
  buildQuarterlyAverageComparison,
  buildSavingsComponents,
  buildSpendingHeatmap,
  buildSubscriptionAnnualCost,
  buildSubscriptionPriceIncreases,
  buildWeekdayHeatmap,
  classifyBookedRecurring,
  calendarMovement,
  generateBucketPeriods,
  truncateToBucketStart,
} from './advanced-metrics.js';
import {
  ADVANCED_METRIC as METRIC,
  GRANULARITY,
  type AdvancedAnalytics,
  type AdvancedAnalyticsQuery,
  type AdvancedMetric,
  type AdvancedMetricData,
  type AnalyticsFlowRow,
  type AnalyticsStore,
  type BookedMoneyRow,
  type ConvertedDebtCostRow,
  type ScheduledOutflowRow,
  type TransactionFlowRow,
} from './analytics.port.js';

function serialize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serialize(entry)]),
    );
  }
  return value;
}

const utcDate = (date: Date): string => date.toISOString().slice(0, 10);
const endOfDate = (date: string): Date => new Date(`${date}T23:59:59.999Z`);
function monthEnd(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return utcDate(date);
}

function actualEvent(
  row: TransactionFlowRow,
  amountMinor: bigint,
): ScheduledOutflowRow {
  const isIncome = row.type === 'income';
  const kind = isIncome
    ? 'income'
    : row.type === 'fund_contribution'
      ? 'fund_contribution'
      : 'transaction';
  const direction =
    isIncome ||
    row.type === 'refund' ||
    (row.type === 'adjustment' && amountMinor > 0n)
      ? 'inflow'
      : 'outflow';
  const label =
    row.description ??
    row.categoryName ??
    (isIncome ? 'Income' : 'Transaction');
  return {
    kind,
    direction,
    label,
    refId: row.id,
    state: 'actual',
    amountMinor,
    scheduledAt: row.occurredAt,
  };
}

export async function evaluateAdvancedAnalytics(
  store: AnalyticsStore,
  client: TransactionClient,
  query: AdvancedAnalyticsQuery,
  currency: string,
  now: Date,
): Promise<AdvancedAnalytics> {
  const { workspaceId, from, to, filters } = query;
  const today = utcDate(now);
  const observedTo = to < today ? to : today;
  const observedAt = to < today ? endOfDate(to) : now;
  const assumptions = new Set([
    'Calendar dates and period boundaries are UTC.',
  ]);
  const missingData = new Set<string>();
  const unknownMonths = new Set<string>();
  const rates = new Map<string, SelectedFxRate | undefined>();
  const usage = new FxUsage();
  const usageByMonth = new Map<string, FxUsage>();

  const publish = <M extends AdvancedMetric>(
    metric: M,
    data: AdvancedMetricData[NoInfer<M>],
    explanation: string,
  ): AdvancedAnalytics<M> => {
    const usesAvailableBookings =
      metric === METRIC.SPENDING_HEATMAP ||
      metric === METRIC.WEEKDAY_HEATMAP ||
      metric === METRIC.RECURRING_VS_VARIABLE;
    for (const [month, used] of usageByMonth) {
      if (usesAvailableBookings || !unknownMonths.has(month))
        usage.include(used);
    }
    return {
      metric,
      generatedAt: now.toISOString(),
      currency,
      assumptions: [...assumptions],
      missingData: [...missingData].sort(),
      data: serialize(data) as AdvancedAnalytics<M>['data'],
      explanation,
      ...usage.fields(),
    };
  };

  function markObservedRange() {
    if (from > observedTo || to > today)
      missingData.add(`Booked history after ${today} is unavailable.`);
    if (from > observedTo) return;
    const first = truncateToBucketStart(
      new Date(`${from}T00:00:00Z`),
      GRANULARITY.MONTH,
    );
    const last = truncateToBucketStart(
      endOfDate(observedTo),
      GRANULARITY.MONTH,
    );
    if (
      from !== first ||
      observedTo !== monthEnd(last) ||
      observedTo === today
    ) {
      assumptions.add(
        'Partial UTC months are clipped to the selected dates and observed time, without extrapolation.',
      );
    }
  }

  const convert = async (
    amount: bigint,
    source: string,
    at: Date,
    applied = usage,
  ): Promise<bigint | undefined> => {
    if (source === currency || amount === 0n) return amount;
    const key = `${source}/${at.toISOString()}`;
    if (!rates.has(key))
      rates.set(
        key,
        await store.findExchangeRate(
          client,
          workspaceId,
          source,
          currency,
          at,
          true,
        ),
      );
    const rate = rates.get(key);
    if (!rate) {
      missingData.add(
        `No historical exchange rate ${source} → ${currency} effective by ${utcDate(at)}.`,
      );
      return undefined;
    }
    applied.add(describeFxRate(source, currency, rate));
    return BigInt(multiplyMinorByRate(amount.toString(), rate.rate));
  };

  function monthlyUsage(at: Date): FxUsage {
    const month = truncateToBucketStart(at, GRANULARITY.MONTH);
    const applied = usageByMonth.get(month) ?? new FxUsage();
    usageByMonth.set(month, applied);
    return applied;
  }

  async function bookings(
    other = false,
    recurring = false,
    until = observedTo,
  ) {
    if (from > until) return [];
    if (recurring && !(await store.hasRecurringHistory(client)))
      missingData.add('Recorded recurring-rule links are unavailable.');
    const rows = await store.readTransactionsInPeriod(
      client,
      workspaceId,
      from,
      until,
      filters,
      other,
      recurring,
    );
    return until === today ? rows.filter((row) => row.occurredAt <= now) : rows;
  }

  async function loadFlows(
    other = false,
    recurring = false,
    side?: 'expense' | 'income',
  ) {
    markObservedRange();
    const flows: AnalyticsFlowRow[] = [];
    const obligations: BookedMoneyRow[] = [];
    for (const row of await bookings(other, recurring)) {
      if (side === 'expense' && row.type === 'income') continue;
      if (side === 'income' && row.type !== 'income') continue;
      if (row.type === 'adjustment') continue;
      const amountMinor = await convert(
        BigInt(row.amountMinor),
        row.currency,
        row.occurredAt,
        monthlyUsage(row.occurredAt),
      );
      if (amountMinor === undefined) {
        unknownMonths.add(
          truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH),
        );
        continue;
      }
      if (
        row.type === 'income' ||
        row.type === 'expense' ||
        row.type === 'refund'
      ) {
        flows.push({
          type: row.type,
          amountMinor,
          occurredAt: row.occurredAt,
          payeeId: row.payeeId,
          essential: row.essential,
          extraordinary: row.extraordinary,
          recurrent: row.recurrent,
        });
      } else
        obligations.push({
          type: row.type,
          occurredAt: row.occurredAt,
          amountMinor,
        });
    }
    return { flows, obligations };
  }

  function monthly(flows: readonly AnalyticsFlowRow[]) {
    if (from > observedTo) return [];
    return buildMonthlySavingsCapacity(from, observedTo, flows).filter(
      (point) => !unknownMonths.has(point.month),
    );
  }

  switch (query.metric) {
    case METRIC.MONTHLY_SAVINGS_CAPACITY: {
      const { flows, obligations } = await loadFlows(true, true);
      assumptions.add(
        'Obligations are booked debt payments; current savings are booked fund contributions in each month. Extraordinary expenses are not discretionary.',
      );
      return publish(
        query.metric,
        { series: buildSavingsComponents(monthly(flows), flows, obligations) },
        'Monthly savings capacity series over the period.',
      );
    }
    case METRIC.INCOME_STABILITY: {
      const { flows } = await loadFlows(false, false, 'income');
      const stats = buildIncomeStability(monthly(flows), flows, currency);
      return publish(
        query.metric,
        stats,
        `Income stability analysis over ${stats.monthsCounted} month(s) based on monthly income variation.`,
      );
    }
    case METRIC.QUARTERLY_AVERAGE_COMPARISON: {
      const { flows } = await loadFlows();
      const quarters = buildQuarterlyAverageComparison(monthly(flows));
      if (quarters.some((quarter) => quarter.monthsCounted < 3))
        assumptions.add(
          'Partial quarters use only the available months; no extrapolation.',
        );
      return publish(
        query.metric,
        { series: quarters },
        'Quarterly average monthly income, expenses, and savings capacity comparison.',
      );
    }
    case METRIC.WEEKDAY_HEATMAP: {
      const { flows } = await loadFlows(false, false, 'expense');
      return publish(
        query.metric,
        { series: buildWeekdayHeatmap(flows) },
        'Weekday expenditure heatmap showing transaction count and net expenses by day of the week.',
      );
    }
    case METRIC.SPENDING_HEATMAP: {
      const { flows } = await loadFlows(false, false, 'expense');
      return publish(
        query.metric,
        { cells: buildSpendingHeatmap(flows, currency) },
        'Net expenses grouped by UTC weekday and day of month.',
      );
    }
    case METRIC.SUBSCRIPTION_PRICE_INCREASES: {
      const rows = await store.readSubscriptionsWithPreviousAmount(
        client,
        workspaceId,
        filters,
      );
      const result = buildSubscriptionPriceIncreases(rows);
      const caveats: string[] = [];
      if (result.excludedForCurrencyMismatch > 0)
        caveats.push(
          `${result.excludedForCurrencyMismatch} subscription(s) excluded due to currency mismatch`,
        );
      if (result.excludedForZeroPrevious > 0)
        caveats.push(
          `${result.excludedForZeroPrevious} subscription(s) excluded due to zero previous amount`,
        );
      caveats.forEach((reason) => missingData.add(reason));
      assumptions.add(
        'This metric compares currently recorded prices in native currencies, not a historical price series.',
      );
      return publish(
        query.metric,
        result,
        `Detected price increases across active subscriptions.${caveats.length ? ` Caveat: ${caveats.join('; ')}.` : ''}`,
      );
    }
    case METRIC.SUBSCRIPTION_ANNUAL_COST: {
      assumptions.add(
        'Annual cost is estimated from current prices and cadence. The total includes only subscriptions with a known annual cost.',
      );
      const subscriptions = await store.readActiveSubscriptions(
        client,
        workspaceId,
        filters,
      );
      return publish(
        query.metric,
        await buildSubscriptionAnnualCost(
          subscriptions,
          currency,
          (amount, source) => convert(amount, source, now),
          missingData,
        ),
        'Estimated yearly cost of active subscriptions.',
      );
    }
    case METRIC.RECURRING_VS_VARIABLE: {
      const { flows } = await loadFlows(false, true, 'expense');
      const subscriptions = await store.readActiveSubscriptions(
        client,
        workspaceId,
        filters,
      );
      const result = classifyBookedRecurring(from, to, flows, subscriptions);
      if (result.unclassifiedSubscriptionCount > 0)
        missingData.add(
          `${result.unclassifiedSubscriptionCount} subscription(s) without recorded transaction or rule links.`,
        );
      assumptions.add(
        'Recurring expenses require a recorded booking link; essential and extraordinary flags are separate from recurrence.',
      );
      return publish(
        query.metric,
        result,
        'Comparison of committed recurring expenses against variable expenses over the period.',
      );
    }
    case METRIC.DEBT_COST_EVOLUTION: {
      markObservedRange();
      const rows =
        from <= observedTo
          ? await store.readDebtPaymentCostsInPeriod(
              client,
              workspaceId,
              from,
              observedTo,
              filters,
            )
          : [];
      const costs: ConvertedDebtCostRow[] = [];
      for (const row of rows) {
        if (row.occurredAt > now) continue;
        const applied = monthlyUsage(row.occurredAt);
        const principal = await convert(
          BigInt(row.principalPaidMinor ?? '0'),
          row.currency,
          row.occurredAt,
          applied,
        );
        const interest = await convert(
          BigInt(row.interestMinor),
          row.currency,
          row.occurredAt,
          applied,
        );
        const fee = await convert(
          BigInt(row.feeMinor),
          row.currency,
          row.occurredAt,
          applied,
        );
        if (
          principal === undefined ||
          interest === undefined ||
          fee === undefined
        ) {
          unknownMonths.add(
            truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH),
          );
        } else
          costs.push({
            principalPaidMinor: principal,
            interestMinor: interest,
            feeMinor: fee,
            occurredAt: row.occurredAt,
          });
      }
      const terms =
        from <= observedTo && !filters
          ? await store.readDebtTerms(client, workspaceId, observedAt)
          : [];
      if (filters)
        assumptions.add(
          'Debt outlook is workspace-level and is omitted with transaction filters.',
        );
      const debtOutlook = terms.map(buildDebtOutlook);
      for (const item of debtOutlook)
        if (item.estimatedFutureCost === null)
          missingData.add(
            `No reliable monthly payoff estimate for debt ${item.debtId}.`,
          );
      assumptions.add(
        'Debt estimates assume fixed rates, monthly minimum payments and no unrecorded future fees.',
      );
      return publish(
        query.metric,
        buildDebtCostEvolution(
          from,
          observedTo,
          costs,
          debtOutlook,
          unknownMonths,
        ),
        'Monthly evolution of debt interest and fee costs across the period.',
      );
    }
    case METRIC.FINANCIAL_CALENDAR: {
      assumptions.add(
        'Expectations use recorded next dates, not inferred historical schedules; booked movements and reminders are excluded from expected totals.',
      );
      const events: ScheduledOutflowRow[] = [];
      for (const row of await bookings(true, false, to)) {
        const amount = await convert(
          BigInt(row.amountMinor),
          row.currency,
          row.occurredAt <= now ? row.occurredAt : now,
        );
        if (amount !== undefined) events.push(actualEvent(row, amount));
      }
      const scheduled = await store.readScheduledOutflows(
        client,
        workspaceId,
        from,
        to,
        filters,
      );
      for (const row of scheduled) {
        const raw =
          row.kind === 'recurring_rule' && row.template
            ? row.template.amount?.amountMinor
            : row.amountMinor;
        const source = row.template?.amount?.currency ?? row.currency;
        if (
          !source ||
          raw == null ||
          !/^-?\d+$/.test(String(raw)) ||
          row.kind === 'reminder' ||
          (row.kind === 'recurring_rule' &&
            row.template &&
            !calendarMovement(row.template.type ?? ''))
        ) {
          events.push(row);
          continue;
        }
        const date =
          row.scheduledAt ??
          (row.scheduledDate ? endOfDate(row.scheduledDate) : now);
        const amount = await convert(
          BigInt(raw),
          source,
          date <= now ? date : now,
        );
        if (amount === undefined) continue;
        events.push({
          ...row,
          amountMinor: amount,
          ...(row.template
            ? {
                template: {
                  ...row.template,
                  amount: asMoney(amount, currency),
                },
              }
            : {}),
        });
      }
      const unscheduled = filters
        ? 0
        : await store.readActiveDebtsWithoutScheduledAmount(
            client,
            workspaceId,
          );
      const calendar = buildFinancialCalendar(from, to, events, unscheduled);
      const caveats: string[] = [];
      if (calendar.debtsWithoutScheduledAmount > 0)
        caveats.push(
          `${calendar.debtsWithoutScheduledAmount} active debt(s) without scheduled payment amount`,
        );
      if (calendar.recurringRulesWithUnreadableTemplate > 0)
        caveats.push(
          `${calendar.recurringRulesWithUnreadableTemplate} recurring rule(s) with unreadable template`,
        );
      caveats.forEach((reason) => missingData.add(reason));
      return publish(
        query.metric,
        calendar,
        `Expected scheduled outflows by calendar day over the period.${caveats.length ? ` Caveat: ${caveats.join('; ')}.` : ''}`,
      );
    }
    case METRIC.BALANCE_PROJECTION: {
      const { flows } = await loadFlows();
      let opening = 0n;
      let openingKnown = true;
      for (const row of await store.readAccountNativeBalances(
        client,
        workspaceId,
        filters?.accountIds,
      )) {
        const amount = await convert(
          BigInt(row.nativeBalanceMinor),
          row.currency,
          now,
        );
        if (amount === undefined) openingKnown = false;
        else opening += amount;
      }
      const projection = buildBalanceProjection(
        from,
        to,
        opening,
        monthly(flows),
      );
      if (!openingKnown)
        missingData.add(
          'Opening balance is incomplete; no projection is shown.',
        );
      if (!projection.basisMonths)
        missingData.add('No observed months for projection.');
      return publish(
        query.metric,
        {
          ...projection,
          months:
            openingKnown && projection.basisMonths ? projection.months : [],
        },
        `Extrapolation of future balances based on the historical monthly mean over basisMonths (${projection.basisMonths}) month(s); this is an extrapolation, never an observation.`,
      );
    }
    case METRIC.NET_WORTH_HISTORY: {
      markObservedRange();
      assumptions.add(
        'Net worth uses recorded UTC month-end positions (or the selected cut for a partial month); only account filters apply.',
      );
      const dates =
        from > observedTo
          ? []
          : generateBucketPeriods(from, observedTo, GRANULARITY.MONTH).map(
              (month) => {
                const end = monthEnd(month);
                return end < observedTo ? end : observedTo;
              },
            );
      const rows = dates.length
        ? await store.readHistoricPositions(
            client,
            workspaceId,
            dates,
            now,
            filters?.accountIds,
          )
        : [];
      const series = await buildNetWorthHistory(
        rows,
        dates,
        currency,
        (amount, source, date, applied) =>
          convert(
            amount,
            source,
            date === today ? now : endOfDate(date),
            applied,
          ),
        missingData,
        usage,
      );
      return publish(
        query.metric,
        { series },
        'Recorded assets and debts valued using rates effective at each cut.',
      );
    }
  }
}
