import { FxUsage } from '../platform/currency-conversion.js';
import {
  GRANULARITY,
  type ActiveSubscriptionRow,
  type AnalyticsFlowRow,
  type AnnualSubscriptionItem,
  type BookedMoneyRow,
  type BalanceProjection,
  type BalanceProjectionPoint,
  type ConvertedDebtCostRow,
  type ConvertedFlowRow,
  type ConvertedSubscriptionRow,
  type DebtCostEvolution,
  type DebtCostEvolutionPoint,
  type DebtOutlook,
  type DebtTermsRow,
  type HistoricPositionRow,
  type NetWorthPoint,
  type SavingsComponents,
  type FinancialCalendar,
  type FinancialCalendarDay,
  type IncomeStability,
  type Money,
  type MonthlyCapacityPoint,
  type QuarterlyAveragePoint,
  type RecurringVsVariable,
  type ScheduledOutflowItem,
  type ScheduledOutflowRow,
  type SpendingHeatmapCell,
  type SubscriptionAnnualCost,
  type SubscriptionPriceIncreaseItem,
  type SubscriptionPriceIncreases,
  type SubscriptionPriceRow,
  type WeekdayHeatmapPoint,
} from './analytics.port.js';
import {
  computeIncreasePercent,
  roundDivHalfAwayFromZero,
} from '../platform/percentage-change.js';

import {
  buildMonthlySavingsCapacity,
  generateBucketPeriods,
  truncateToBucketStart,
} from '../platform/monthly-capacity.js';

export {
  buildMonthlySavingsCapacity,
  generateBucketPeriods,
  truncateToBucketStart,
};

/**
 * Integer square root for BigInt using Newton's method, returning floor(sqrt(value)).
 * Throws RangeError on negative input. Handles 0n and 1n without looping.
 */
export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError('Square root of negative BigInt');
  }
  if (value === 0n || value === 1n) {
    return value;
  }
  let x0 = 1n << ((BigInt(value.toString(2).length) + 1n) / 2n);
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

/**
 * §3.4 buildIncomeStability
 * Derived from the monthly series (§3.3), zero months included.
 * - meanMonthlyIncomeMinor: integer mean, half-away-from-zero rounding using BigInt.
 * - coefficientOfVariationPercent: (populationStdDev / mean) * 100, 2 decimals, half-away-from-zero.
 *   - If meanMonthlyIncomeMinor is 0 -> null.
 *   - If monthsCounted is 0 -> all money fields 0n and CV is null.
 *   - Population std dev: divide by N, not N - 1. With N = 1, stddev is 0 and CV is 0.
 */
export function buildIncomeStability(
  monthlySeries: readonly MonthlyCapacityPoint[],
  rows: readonly AnalyticsFlowRow[] = [],
  currency = 'USD',
): IncomeStability {
  const counts = monthlySeries
    .map((point) => point.incomeMinor)
    .sort(compareMinor);
  const middle = Math.floor(counts.length / 2);
  const first = monthlySeries[0]?.incomeMinor;
  const last = monthlySeries.at(-1)?.incomeMinor;
  const months = new Set(monthlySeries.map(({ month }) => month));
  const sources = new Map<string | null, bigint>();
  let totalIncome = 0n;
  for (const row of rows) {
    if (
      row.type !== 'income' ||
      row.amountMinor <= 0n ||
      !months.has(truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH))
    )
      continue;
    const payeeId = row.payeeId ?? null;
    sources.set(payeeId, (sources.get(payeeId) ?? 0n) + row.amountMinor);
    totalIncome += row.amountMinor;
  }
  return {
    ...buildIncomeVariation(monthlySeries),
    medianMonthlyIncomeMinor:
      counts.length === 0
        ? 0n
        : counts.length % 2 === 1
          ? counts[middle]
          : roundDivHalfAwayFromZero(counts[middle - 1] + counts[middle], 2n),
    trendPercent:
      first && last !== undefined && counts.length > 1
        ? computeQuarterlyDeltaPercent(last, first)
        : null,
    regularityPercent: percentage(
      BigInt(counts.filter((amount) => amount > 0n).length),
      BigInt(counts.length),
    ),
    sourceConcentration: [...sources]
      .sort(
        ([a, x], [b, y]) =>
          compareMinor(y, x) || (a ?? '').localeCompare(b ?? ''),
      )
      .map(([payeeId, amount]) => ({
        payeeId,
        amount: asMoney(amount, currency),
        sharePercent: percentage(amount, totalIncome)!,
      })),
  };
}

function buildIncomeVariation(
  monthlySeries: readonly MonthlyCapacityPoint[],
): Pick<
  IncomeStability,
  | 'monthsCounted'
  | 'meanMonthlyIncomeMinor'
  | 'minMonthlyIncomeMinor'
  | 'maxMonthlyIncomeMinor'
  | 'coefficientOfVariationPercent'
> {
  const monthsCounted = monthlySeries.length;
  if (monthsCounted === 0) {
    return {
      monthsCounted: 0,
      meanMonthlyIncomeMinor: 0n,
      minMonthlyIncomeMinor: 0n,
      maxMonthlyIncomeMinor: 0n,
      coefficientOfVariationPercent: null,
    };
  }

  let minMonthlyIncomeMinor = monthlySeries[0].incomeMinor;
  let maxMonthlyIncomeMinor = monthlySeries[0].incomeMinor;
  let totalIncomeMinor = 0n;
  let sumSquaredIncomeMinor = 0n;

  for (const point of monthlySeries) {
    if (point.incomeMinor < minMonthlyIncomeMinor) {
      minMonthlyIncomeMinor = point.incomeMinor;
    }
    if (point.incomeMinor > maxMonthlyIncomeMinor) {
      maxMonthlyIncomeMinor = point.incomeMinor;
    }
    totalIncomeMinor += point.incomeMinor;
    sumSquaredIncomeMinor += point.incomeMinor * point.incomeMinor;
  }

  const meanMonthlyIncomeMinor = roundDivHalfAwayFromZero(
    totalIncomeMinor,
    BigInt(monthsCounted),
  );

  // §3.4: If meanMonthlyIncomeMinor is 0 -> null. Never NaN, never Infinity, never a fabricated 0.
  if (meanMonthlyIncomeMinor === 0n) {
    return {
      monthsCounted,
      meanMonthlyIncomeMinor,
      minMonthlyIncomeMinor,
      maxMonthlyIncomeMinor,
      coefficientOfVariationPercent: null,
    };
  }

  // §3.4: With a single month, population stddev is 0 and CV is 0.
  if (monthsCounted === 1) {
    return {
      monthsCounted,
      meanMonthlyIncomeMinor,
      minMonthlyIncomeMinor,
      maxMonthlyIncomeMinor,
      coefficientOfVariationPercent: 0,
    };
  }

  // §3.4: Population statistics collapse to an exact integer expression. With N observations
  // xᵢ, T = Σxᵢ, and Q = Σxᵢ²:
  // population std dev = sqrt(N·Q - T²) / N
  // CV% = 100 · std dev / |mean| = 100 · [sqrt(S)/N] / (|T|/N) = 100 · sqrt(S) / |T|
  // where S = N·Q - T². N cancels completely.
  const N = BigInt(monthsCounted);
  const S = N * sumSquaredIncomeMinor - totalIncomeMinor * totalIncomeMinor;
  if (S === 0n) {
    return {
      monthsCounted,
      meanMonthlyIncomeMinor,
      minMonthlyIncomeMinor,
      maxMonthlyIncomeMinor,
      coefficientOfVariationPercent: 0,
    };
  }

  const A = S * 100000000n; // 10^8, so sqrt(A) = 10000 * sqrt(S)
  const D = totalIncomeMinor < 0n ? -totalIncomeMinor : totalIncomeMinor;
  let k = bigintSqrt(A) / D;
  while ((k + 1n) ** 2n * D * D <= A) {
    k += 1n;
  }
  // The tie-break line is the exact restatement of sqrt(A)/D - k >= 1/2, squared to stay in integers.
  if (4n * A >= (2n * k + 1n) ** 2n * D * D) {
    k += 1n;
  }
  const coefficientOfVariationPercent = Number(k) / 100;

  return {
    monthsCounted,
    meanMonthlyIncomeMinor,
    minMonthlyIncomeMinor,
    maxMonthlyIncomeMinor,
    coefficientOfVariationPercent,
  };
}

/**
 * Computes percentage delta between current and previous quarterly savings capacity:
 * ((current - previous) / |previous|) * 100
 * - 2 decimals, half-away-from-zero rounding using BigInt scaled integer arithmetic.
 * - Uses |previous| in the denominator so that moving from -100 to -50 reads as +50% improvement.
 */
function computeQuarterlyDeltaPercent(
  current: bigint,
  previous: bigint,
): number | null {
  if (previous === 0n) {
    return null;
  }
  if (current === previous) {
    return 0;
  }

  // §3.5: Absolute value of previous in denominator so negative-to-less-negative reads as improvement
  const den = previous < 0n ? -previous : previous;
  const num = (current - previous) * 10000n;

  const q = num / den;
  const r = num % den;

  let roundedHundredths = q;
  if (num >= 0n) {
    if (2n * r >= den) {
      roundedHundredths = q + 1n;
    }
  } else {
    const absR = -r;
    if (2n * absR >= den) {
      roundedHundredths = q - 1n;
    }
  }

  const result = Number(roundedHundredths) / 100;
  return Object.is(result, -0) ? 0 : result;
}

/**
 * §3.5 buildQuarterlyAverageComparison
 * Groups the §3.3 monthly points by calendar quarter (Q1 = Jan-Mar, UTC).
 * - monthsCounted: how many monthly buckets actually fall in [from, to] (1, 2, or 3).
 *   Never extrapolate a partial quarter to a full one.
 * - Averages: integer, half-away-from-zero, divided by monthsCounted.
 * - savingsCapacityDeltaPercentVsPreviousQuarter:
 *   ((current - previous) / |previous|) * 100, 2 decimals, half-away-from-zero.
 *   - null when the immediately preceding calendar quarter is absent or its average is 0
 *   - uses |previous| in denominator
 * - Order: ascending by quarter. Deterministic.
 */
export function buildQuarterlyAverageComparison(
  monthlySeries: readonly MonthlyCapacityPoint[],
): readonly QuarterlyAveragePoint[] {
  if (monthlySeries.length === 0) {
    return [];
  }

  // Use a calendar quarter ordinal so adjacency also works across years.
  const quarterGroups = new Map<number, MonthlyCapacityPoint[]>();
  for (const point of monthlySeries) {
    const year = Number(point.month.slice(0, 4));
    const monthNum = Number(point.month.slice(5, 7));
    const quarterKey = year * 4 + Math.floor((monthNum - 1) / 3);

    let group = quarterGroups.get(quarterKey);
    if (!group) {
      group = [];
      quarterGroups.set(quarterKey, group);
    }
    group.push(point);
  }

  const sortedQuarters = [...quarterGroups.keys()].sort((a, b) => a - b);
  const results: QuarterlyAveragePoint[] = [];

  for (const [i, quarterKey] of sortedQuarters.entries()) {
    const year = String(Math.floor(quarterKey / 4)).padStart(4, '0');
    const quarter = `${year}-Q${(quarterKey % 4) + 1}`;
    const points = quarterGroups.get(quarterKey)!;
    const monthsCounted = points.length;
    const monthsCountedBigInt = BigInt(monthsCounted);

    let totalIncome = 0n;
    let totalExpenses = 0n;
    let totalSavings = 0n;

    for (const p of points) {
      totalIncome += p.incomeMinor;
      totalExpenses += p.expensesMinor;
      totalSavings += p.savingsCapacityMinor;
    }

    const averageMonthlyIncomeMinor = roundDivHalfAwayFromZero(
      totalIncome,
      monthsCountedBigInt,
    );
    const averageMonthlyExpensesMinor = roundDivHalfAwayFromZero(
      totalExpenses,
      monthsCountedBigInt,
    );
    const averageMonthlySavingsCapacityMinor = roundDivHalfAwayFromZero(
      totalSavings,
      monthsCountedBigInt,
    );

    let savingsCapacityDeltaPercentVsPreviousQuarter: number | null = null;
    if (sortedQuarters[i - 1] === quarterKey - 1) {
      const previousQuarterSavings =
        results[i - 1].averageMonthlySavingsCapacityMinor;
      savingsCapacityDeltaPercentVsPreviousQuarter =
        computeQuarterlyDeltaPercent(
          averageMonthlySavingsCapacityMinor,
          previousQuarterSavings,
        );
    }

    results.push({
      quarter,
      monthsCounted,
      averageMonthlyIncomeMinor,
      averageMonthlyExpensesMinor,
      averageMonthlySavingsCapacityMinor,
      savingsCapacityDeltaPercentVsPreviousQuarter,
    });
  }

  return results;
}

export function asMoney(amount: bigint, currency: string): Money {
  return { amountMinor: amount.toString(), currency };
}

function compareMinor(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function percentage(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  const percent =
    Number(roundDivHalfAwayFromZero(numerator * 10000n, denominator)) / 100;
  return Number.isFinite(percent) ? percent : null;
}

export function buildSpendingHeatmap(
  rows: readonly ConvertedFlowRow[],
  currency: string,
): readonly SpendingHeatmapCell[] {
  const cells = new Map<
    number,
    { weekday: number; dayOfMonth: number; amount: bigint; count: number }
  >();
  for (const row of rows) {
    if (row.type !== 'expense' && row.type !== 'refund') continue;
    const weekday = ((row.occurredAt.getUTCDay() + 6) % 7) + 1;
    const dayOfMonth = row.occurredAt.getUTCDate();
    const key = weekday * 32 + dayOfMonth;
    const cell = cells.get(key) ?? {
      weekday,
      dayOfMonth,
      amount: 0n,
      count: 0,
    };
    cell.amount += row.type === 'expense' ? row.amountMinor : -row.amountMinor;
    cell.count++;
    cells.set(key, cell);
  }
  return [...cells.values()]
    .sort((a, b) => a.weekday - b.weekday || a.dayOfMonth - b.dayOfMonth)
    .map((cell) => ({ ...cell, amount: asMoney(cell.amount, currency) }));
}

interface MutableWeekdayHeatmapPoint {
  readonly weekday: number;
  transactionCount: number;
  totalMinor: bigint;
}

/**
 * §3.6 buildWeekdayHeatmap
 * Pure builder for expense-side weekday heatmap.
 * - Exactly 7 entries, always, ascending 1..7, zero-filled.
 * - Scope: expense-side flow only (expense adds, refund subtracts). Income rows are excluded entirely.
 * - transactionCount: counts the rows that contributed (both expense and refund), not net sign.
 * - weekday: ISO-8601 (1 = Monday ... 7 = Sunday) evaluated in UTC:
 *   ((date.getUTCDay() + 6) % 7) + 1
 */
export function buildWeekdayHeatmap(
  rows: readonly ConvertedFlowRow[],
): readonly WeekdayHeatmapPoint[] {
  // Always exactly 7 entries, ascending 1..7, zero-filled (§3.6)
  const heatmap: MutableWeekdayHeatmapPoint[] = [1, 2, 3, 4, 5, 6, 7].map(
    (weekday) => ({
      weekday,
      transactionCount: 0,
      totalMinor: 0n,
    }),
  );

  for (const row of rows) {
    // §3.6: Scope: expense-side flow only. Income rows are excluded entirely.
    if (row.type !== 'expense' && row.type !== 'refund') {
      continue;
    }

    // ISO-8601 weekday in UTC: 1 = Monday ... 7 = Sunday
    const weekday = ((row.occurredAt.getUTCDay() + 6) % 7) + 1;
    const point = heatmap[weekday - 1];

    // §3.6: transactionCount counts the rows that contributed (both expense and refund)
    point.transactionCount += 1;

    if (row.type === 'expense') {
      point.totalMinor += row.amountMinor;
    } else if (row.type === 'refund') {
      point.totalMinor -= row.amountMinor;
    }
  }

  return heatmap;
}

/**
 * §3.1 buildSubscriptionPriceIncreases
 * Pure builder that calculates detected subscription price increases.
 *
 * Currency conversion note:
 * Amounts stay in their own currency. Do NOT convert. A percentage increase is
 * currency-independent, and converting would invite a missing-rate failure on a
 * metric that does not need one.
 *
 * Rules:
 * - increasePercent computed with computeIncreasePercent from src/platform/percentage-change.ts.
 * - Items included only when increasePercent !== null && increasePercent > 0 (increases only).
 * - Decreases and unchanged amounts counted in decreasedOrUnchangedCount.
 * - Currency mismatches counted in excludedForCurrencyMismatch.
 * - Zero previous amounts counted in excludedForZeroPrevious.
 * - Deterministic order: increasePercent descending, then payeeName ascending, then subscriptionId ascending.
 */
export function buildSubscriptionPriceIncreases(
  rows: readonly SubscriptionPriceRow[],
): SubscriptionPriceIncreases {
  let decreasedOrUnchangedCount = 0;
  let excludedForCurrencyMismatch = 0;
  let excludedForZeroPrevious = 0;
  const items: SubscriptionPriceIncreaseItem[] = [];

  for (const row of rows) {
    const currentAmount = {
      amountMinor: row.currentAmountMinor,
      currency: row.currentCurrency,
    };
    const previousAmount = {
      amountMinor: row.previousAmountMinor,
      currency: row.previousCurrency,
    };

    if (row.currentCurrency !== row.previousCurrency) {
      excludedForCurrencyMismatch += 1;
      continue;
    }

    if (BigInt(row.previousAmountMinor) === 0n) {
      excludedForZeroPrevious += 1;
      continue;
    }

    const increasePercent = computeIncreasePercent(
      currentAmount,
      previousAmount,
    );

    if (increasePercent === null) {
      continue;
    }

    if (increasePercent <= 0) {
      decreasedOrUnchangedCount += 1;
      continue;
    }

    items.push({
      subscriptionId: row.id,
      payeeName: row.payeeName,
      previousAmount,
      currentAmount,
      increasePercent,
    });
  }

  items.sort((a, b) => {
    if (b.increasePercent !== a.increasePercent) {
      return b.increasePercent - a.increasePercent;
    }
    const payeeComparison = a.payeeName.localeCompare(b.payeeName);
    if (payeeComparison !== 0) {
      return payeeComparison;
    }
    return a.subscriptionId.localeCompare(b.subscriptionId);
  });

  return {
    items,
    consideredCount: rows.length,
    decreasedOrUnchangedCount,
    excludedForCurrencyMismatch,
    excludedForZeroPrevious,
  };
}

const FREQUENCY_PER_YEAR: Readonly<Record<string, bigint>> = {
  daily: 365n,
  weekly: 52n,
  biweekly: 26n,
  fortnightly: 26n,
  monthly: 12n,
  bimonthly: 6n,
  quarterly: 4n,
  semiannual: 2n,
  semiannually: 2n,
  biannual: 2n,
  yearly: 1n,
  annual: 1n,
  annually: 1n,
};

function annualFrequency(frequency: string): bigint | undefined {
  const key = frequency.trim().toLowerCase();
  return Object.hasOwn(FREQUENCY_PER_YEAR, key)
    ? FREQUENCY_PER_YEAR[key]
    : undefined;
}

export async function buildSubscriptionAnnualCost(
  rows: readonly ActiveSubscriptionRow[],
  currency: string,
  convert: (amount: bigint, from: string) => Promise<bigint | undefined>,
  missingData: Set<string>,
): Promise<SubscriptionAnnualCost> {
  const items: AnnualSubscriptionItem[] = [];
  let total = 0n;
  for (const row of rows) {
    if (!row.id || !row.payeeName) continue;
    const currentAmount = asMoney(
      BigInt(row.currentAmountMinor),
      row.currentCurrency,
    );
    const previousAmount =
      row.previousAmountMinor != null && row.previousCurrency
        ? asMoney(BigInt(row.previousAmountMinor), row.previousCurrency)
        : undefined;
    const perYear = annualFrequency(row.frequency);
    let annualCost: Money | null = null;
    if (perYear === undefined) {
      missingData.add(`Unknown frequency for subscription ${row.id}.`);
    } else {
      const converted = await convert(
        BigInt(row.currentAmountMinor) * perYear,
        row.currentCurrency,
      );
      if (converted !== undefined) {
        annualCost = asMoney(converted, currency);
        total += converted;
      }
    }
    items.push({
      subscriptionId: row.id,
      payeeName: row.payeeName,
      currentAmount,
      ...(previousAmount
        ? {
            previousAmount,
            increasePercent: computeIncreasePercent(
              currentAmount,
              previousAmount,
            ),
          }
        : {}),
      frequency: row.frequency,
      ...(row.nextExpectedDate
        ? { nextExpectedDate: row.nextExpectedDate }
        : {}),
      annualCost,
    });
  }
  items.sort(
    (a, b) =>
      a.payeeName.localeCompare(b.payeeName) ||
      a.subscriptionId.localeCompare(b.subscriptionId),
  );
  return { items, totalAnnualCost: asMoney(total, currency) };
}

/**
 * §3.2 buildRecurringVsVariable
 * Pure builder that calculates committed recurring spend vs variable expenses.
 *
 * Design constraints:
 * - Matching on payee_name is FORBIDDEN; transactions carry no subscription link,
 *   so recurring spend is computed from active subscriptions.
 * - Currency conversion: Currency conversion of subscription amounts is the caller's job
 *   in the final slice; this builder receives minor units already in the base currency.
 * - Frequency normalisation: exact match only after trim() and toLowerCase() against
 *   pinned table. Unmatched frequencies are excluded from committed total and counted
 *   in unclassifiedSubscriptionCount. Never guess, never drop silently.
 * - Identity invariant: variableMinor is NOT floored at zero. Reports exactly
 *   variableMinor = totalExpensesMinor - committedMinor, negative included, so that
 *   committed + variable === totalExpenses holds as an identity.
 * - committedPercent is null when totalExpensesMinor === 0n, else computed to 2 decimals
 *   using BigInt half-away-from-zero rounding.
 */
export function buildRecurringVsVariable(
  from: string,
  to: string,
  subscriptions: readonly ConvertedSubscriptionRow[],
  totalExpensesMinor: bigint,
): RecurringVsVariable {
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  const msDiff = toDate.getTime() - fromDate.getTime();
  const days = BigInt(Math.round(msDiff / 86400000) + 1);

  let committedMinor = 0n;
  let unclassifiedSubscriptionCount = 0;

  for (const sub of subscriptions) {
    const perYear = annualFrequency(sub.frequency);

    if (perYear === undefined) {
      unclassifiedSubscriptionCount += 1;
      continue;
    }

    // Committed amount over period: roundDivHalfAwayFromZero(amountMinor * perYear * days, 365n)
    const subCommitted = roundDivHalfAwayFromZero(
      sub.amountMinor * perYear * days,
      365n,
    );
    committedMinor += subCommitted;
  }

  // §3.2: variableMinor is NOT floored at zero; preserves identity committed + variable === totalExpenses
  const variableMinor = totalExpensesMinor - committedMinor;

  let committedPercent: number | null = null;
  if (totalExpensesMinor !== 0n) {
    let num = committedMinor * 10000n;
    let den = totalExpensesMinor;
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const q = num / den;
    const r = num % den;

    let roundedHundredths = q;
    if (num >= 0n) {
      if (2n * r >= den) {
        roundedHundredths = q + 1n;
      }
    } else {
      const absR = -r;
      if (2n * absR >= den) {
        roundedHundredths = q - 1n;
      }
    }

    const pct = Number(roundedHundredths) / 100;
    const normalizedPct = Object.is(pct, -0) ? 0 : pct;

    // null here means "not representable" (e.g. non-finite when input magnitude overflows IEEE-754).
    // It shares a value with the zero-expense case. A real database value can
    // never reach it because the column is bigint (int64) — this is a guard on a
    // public exported function, not a live defect.
    committedPercent = Number.isFinite(normalizedPct) ? normalizedPct : null;
  }

  return {
    periodStart: from,
    periodEnd: to,
    committedMinor,
    variableMinor,
    totalExpensesMinor,
    committedPercent,
    consideredSubscriptionCount: subscriptions.length,
    unclassifiedSubscriptionCount,
  };
}

interface DebtCostAccumulator {
  principalPaidMinor: bigint;
  interestMinor: bigint;
  feeMinor: bigint;
}

/**
 * §3.3 buildDebtCostEvolution
 * Pure builder that calculates monthly debt payment costs (interest and fees).
 *
 * Design constraints:
 * - Buckets: monthly, gap-free and zero-filled via generateBucketPeriods(from, to, GRANULARITY.MONTH).
 * - A month with no payments is present with real zeros.
 * - Buckets by occurredAt evaluated in UTC.
 * - Per month: interestMinor, feeMinor, totalCostMinor = interestMinor + feeMinor.
 * - Across the whole period: totalInterestMinor, totalFeeMinor, totalCostMinor.
 * - Currency conversion note: rows arrive already converted to base currency by the caller.
 */
export function buildDebtCostEvolution(
  from: string,
  to: string,
  rows: readonly ConvertedDebtCostRow[],
  debtOutlook: readonly DebtOutlook[] = [],
  unknownMonths: ReadonlySet<string> = new Set(),
): DebtCostEvolution {
  const bucketPeriods =
    from <= to ? generateBucketPeriods(from, to, GRANULARITY.MONTH) : [];

  const bucketMap = new Map<string, DebtCostAccumulator>();
  for (const period of bucketPeriods) {
    if (!unknownMonths.has(period))
      bucketMap.set(period, {
        principalPaidMinor: 0n,
        interestMinor: 0n,
        feeMinor: 0n,
      });
  }

  for (const row of rows) {
    const bucketPeriod = truncateToBucketStart(
      row.occurredAt,
      GRANULARITY.MONTH,
    );
    const bucket = bucketMap.get(bucketPeriod);
    if (!bucket) {
      continue;
    }

    bucket.principalPaidMinor += row.principalPaidMinor ?? 0n;
    bucket.interestMinor += row.interestMinor;
    bucket.feeMinor += row.feeMinor;
  }

  let totalInterestMinor = 0n;
  let totalFeeMinor = 0n;

  const series: DebtCostEvolutionPoint[] = [];
  for (const [month, bucket] of bucketMap) {
    totalInterestMinor += bucket.interestMinor;
    totalFeeMinor += bucket.feeMinor;
    const totalCostMinor = bucket.interestMinor + bucket.feeMinor;
    series.push({
      month,
      ...bucket,
      totalCostMinor,
      paymentsMinor: bucket.principalPaidMinor + totalCostMinor,
    });
  }
  return {
    series,
    totalInterestMinor,
    totalFeeMinor,
    totalCostMinor: totalInterestMinor + totalFeeMinor,
    debtOutlook,
  };
}

export function buildSavingsComponents(
  monthly: readonly MonthlyCapacityPoint[],
  flows: readonly AnalyticsFlowRow[],
  obligations: readonly BookedMoneyRow[],
): readonly SavingsComponents[] {
  const months = new Map(
    monthly.map((point) => [
      point.month,
      {
        ...point,
        recurringIncomeMinor: 0n,
        essentialExpensesMinor: 0n,
        discretionaryExpensesMinor: 0n,
        obligationsMinor: 0n,
        currentSavingsMinor: 0n,
      },
    ]),
  );
  for (const row of flows) {
    const month = months.get(
      truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH),
    );
    if (!month) continue;
    if (row.type === 'income') {
      if (row.recurrent) month.recurringIncomeMinor += row.amountMinor;
    } else {
      const net = row.type === 'refund' ? -row.amountMinor : row.amountMinor;
      if (row.essential) month.essentialExpensesMinor += net;
      else if (!row.extraordinary) month.discretionaryExpensesMinor += net;
    }
  }
  for (const row of obligations) {
    const month = months.get(
      truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH),
    );
    if (!month) continue;
    if (row.type === 'debt_payment') {
      month.obligationsMinor += row.amountMinor;
      month.savingsCapacityMinor -= row.amountMinor;
    } else if (row.type === 'fund_contribution')
      month.currentSavingsMinor += row.amountMinor;
  }
  return [...months.values()];
}

export function classifyBookedRecurring(
  from: string,
  to: string,
  flows: readonly AnalyticsFlowRow[],
  subscriptions: readonly ActiveSubscriptionRow[],
): RecurringVsVariable {
  let totalExpensesMinor = 0n;
  let committedMinor = 0n;
  for (const row of flows) {
    if (row.type === 'income') continue;
    const amount = row.type === 'refund' ? -row.amountMinor : row.amountMinor;
    totalExpensesMinor += amount;
    if (row.recurrent) committedMinor += amount;
  }
  return {
    periodStart: from,
    periodEnd: to,
    committedMinor,
    variableMinor: totalExpensesMinor - committedMinor,
    totalExpensesMinor,
    committedPercent: percentage(committedMinor, totalExpensesMinor),
    consideredSubscriptionCount: subscriptions.length,
    unclassifiedSubscriptionCount: subscriptions.filter(
      (row) => !row.observationId && !row.recurringRuleId,
    ).length,
  };
}

export function buildDebtOutlook(row: DebtTermsRow): DebtOutlook {
  const unknown = {
    debtId: row.id,
    estimatedFutureCost: null,
    estimatedRemainingMonths: null,
  };
  let balance = BigInt(row.outstandingBalanceMinor);
  const result = (interest: bigint, months: number): DebtOutlook => ({
    debtId: row.id,
    estimatedFutureCost: asMoney(interest, row.currency),
    estimatedRemainingMonths: months,
  });
  if (balance === 0n) return result(0n, 0);
  if (
    row.rateType !== 'fixed' ||
    row.minimumPaymentMinor === null ||
    (row.frequency && row.frequency !== 'monthly')
  )
    return unknown;
  const installment = BigInt(row.minimumPaymentMinor);
  const [integer, fraction = ''] = row.annualRate.split('.');
  if (!/^\d+$/.test(integer) || (fraction && !/^\d+$/.test(fraction)))
    return unknown;
  const rate = BigInt(integer + fraction);
  const denominator = 12n * 10n ** BigInt(fraction.length);
  let totalInterest = 0n;
  for (let month = 1; month <= 1200; month++) {
    const interest = roundDivHalfAwayFromZero(balance * rate, denominator);
    if (installment <= interest) return unknown;
    totalInterest += interest;
    balance += interest - installment;
    if (balance <= 0n) return result(totalInterest, month);
  }
  return unknown;
}

export async function buildNetWorthHistory(
  rows: readonly HistoricPositionRow[],
  dates: readonly string[],
  currency: string,
  convert: (
    amount: bigint,
    from: string,
    date: string,
    applied: FxUsage,
  ) => Promise<bigint | undefined>,
  missingData: Set<string>,
  usage: FxUsage,
): Promise<readonly NetWorthPoint[]> {
  const byDate = new Map<string, HistoricPositionRow[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }
  async function value(
    positions: readonly HistoricPositionRow[],
    date: string,
  ) {
    let assets = 0n,
      debts = 0n;
    let complete = true;
    const applied = new FxUsage();
    for (const row of positions) {
      const amount = await convert(
        BigInt(row.amountMinor),
        row.currency,
        date,
        applied,
      );
      if (amount === undefined) complete = false;
      else if (row.kind === 'debt') debts += amount;
      else if (amount < 0n) debts -= amount;
      else assets += amount;
    }
    if (!complete) return undefined;
    usage.include(applied);
    return { assets, debts, netWorth: assets - debts };
  }
  const series: NetWorthPoint[] = [];
  let previous:
    | { positions: readonly HistoricPositionRow[]; worth: bigint }
    | undefined;
  for (const date of dates) {
    const positions = byDate.get(date);
    if (!positions?.length) {
      missingData.add(`No recorded accounts or debts at ${date}.`);
      previous = undefined;
      continue;
    }
    const current = await value(positions, date);
    if (!current) {
      previous = undefined;
      continue;
    }
    const revalued = previous && (await value(previous.positions, date));
    series.push({
      date,
      assets: asMoney(current.assets, currency),
      debts: asMoney(current.debts, currency),
      netWorth: asMoney(current.netWorth, currency),
      fxValuationChange:
        revalued && previous
          ? asMoney(revalued.netWorth - previous.worth, currency)
          : null,
    });
    previous = { positions, worth: current.netWorth };
  }
  return series;
}

export function calendarMovement(
  type: string,
): Pick<ScheduledOutflowItem, 'kind' | 'direction'> | undefined {
  switch (type) {
    case 'income':
      return { kind: 'income', direction: 'inflow' };
    case 'expense':
      return { kind: 'recurring_rule', direction: 'outflow' };
    case 'debt_payment':
      return { kind: 'debt_payment', direction: 'outflow' };
    case 'fund_contribution':
      return { kind: 'fund_contribution', direction: 'outflow' };
    default:
      return undefined;
  }
}

const INTEGER_AMOUNT_PATTERN = /^-?[0-9]+$/;

function parseRowDateToUtcDateString(
  rawDate: Date | string | null | undefined,
): string | null {
  if (!rawDate) {
    return null;
  }
  if (rawDate instanceof Date) {
    const y = rawDate.getUTCFullYear();
    const m = String(rawDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(rawDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof rawDate === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return rawDate;
    }
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) {
      const y = parsed.getUTCFullYear();
      const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
      const d = String(parsed.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

/**
 * §3.1 buildFinancialCalendar
 * Pure builder that calculates the financial calendar of forward-dated scheduled outflows.
 *
 * Design constraints:
 * - Only days that carry at least one item appear. A 365-day period with three scheduled
 *   charges returns three days, not 365. This is the opposite of the monthly-bucket rule and
 *   it is deliberate: a calendar lists events, a time series measures periods.
 *   (Commented so nobody "fixes" it later).
 * - Amounts are reported as positive magnitudes, because the field is named expectedOutflow
 *   and its direction is in the name. This is NOT a clamp: no sign is discarded, the sources
 *   hold positive scheduled amounts.
 * - Only outflows: From the recurring template's type, include expense, debt_payment, and
 *   fund_contribution. Exclude income, refund, transfer, and adjustment. Subscriptions and
 *   debt payments are outflows by construction.
 * - Deterministic order: days ascending by date; within a day, items ascending by kind, then refId.
 * - totalExpectedOutflowMinor equals the sum of every day (asserted directly).
 */
export function buildFinancialCalendar(
  from: string,
  to: string,
  rows: readonly ScheduledOutflowRow[],
  debtsWithoutScheduledAmount = 0,
  unreadableTemplateCount = 0,
): FinancialCalendar {
  let countedDebtsWithoutScheduledAmount = 0;
  let countedUnreadableTemplate = 0;

  const daysMap = new Map<string, ScheduledOutflowItem[]>();

  for (const row of rows) {
    const dateStr = parseRowDateToUtcDateString(
      row.scheduledDate ?? row.scheduledAt,
    );
    if (!dateStr || dateStr < from || dateStr > to) {
      continue;
    }

    if (row.kind === 'reminder') {
      const items = daysMap.get(dateStr) ?? [];
      items.push({
        kind: row.kind,
        refId: row.refId,
        label: row.label,
        amountMinor: null,
        state: 'scheduled',
        direction: 'none',
      });
      daysMap.set(dateStr, items);
      continue;
    }
    if (row.kind === 'installment' || row.kind === 'debt_payment') {
      if (row.amountMinor === null || row.amountMinor === undefined) {
        countedDebtsWithoutScheduledAmount += 1;
        continue;
      }
      let amount: bigint;
      if (typeof row.amountMinor === 'bigint') {
        amount = row.amountMinor;
      } else if (
        typeof row.amountMinor === 'string' &&
        INTEGER_AMOUNT_PATTERN.test(row.amountMinor)
      ) {
        amount = BigInt(row.amountMinor);
      } else {
        countedDebtsWithoutScheduledAmount += 1;
        continue;
      }
      // Positive magnitude: direction lives in expectedOutflow name; not a clamp (no sign discarded to hide value)
      const positiveAmount = amount < 0n ? -amount : amount;
      let dayItems = daysMap.get(dateStr);
      if (!dayItems) {
        dayItems = [];
        daysMap.set(dateStr, dayItems);
      }
      dayItems.push({
        kind: row.kind,
        refId: row.refId,
        label: row.label,
        amountMinor: positiveAmount,
        state: row.state ?? 'scheduled',
        direction: row.direction ?? 'outflow',
      });
    } else if (row.kind !== 'recurring_rule') {
      if (row.amountMinor === null || row.amountMinor === undefined) {
        continue;
      }
      let amount: bigint;
      if (typeof row.amountMinor === 'bigint') {
        amount = row.amountMinor;
      } else if (
        typeof row.amountMinor === 'string' &&
        INTEGER_AMOUNT_PATTERN.test(row.amountMinor)
      ) {
        amount = BigInt(row.amountMinor);
      } else {
        continue;
      }
      // Positive magnitude: direction lives in expectedOutflow name; not a clamp (no sign discarded to hide value)
      const positiveAmount = amount < 0n ? -amount : amount;
      let dayItems = daysMap.get(dateStr);
      if (!dayItems) {
        dayItems = [];
        daysMap.set(dateStr, dayItems);
      }
      dayItems.push({
        kind: row.kind,
        refId: row.refId,
        label: row.label,
        amountMinor: positiveAmount,
        state: row.state ?? 'scheduled',
        direction: row.direction ?? 'outflow',
      });
    } else {
      if (row.template) {
        const templateType = row.template.type;
        // An allow-list must require the known-good, never merely reject the known-bad.
        // A missing discriminator is not evidence that a charge is an outflow, and this
        // column guarantees only `jsonb not null`.
        const movement = calendarMovement(templateType ?? '');
        if (!movement) {
          countedUnreadableTemplate += 1;
          continue;
        }
        // Validate amountMinor and currency presence
        const templateAmount = row.template.amount;
        if (
          !templateAmount ||
          typeof templateAmount.amountMinor !== 'string' ||
          !INTEGER_AMOUNT_PATTERN.test(templateAmount.amountMinor) ||
          !templateAmount.currency
        ) {
          countedUnreadableTemplate += 1;
          continue;
        }
        const amount = BigInt(templateAmount.amountMinor);
        // Positive magnitude: direction lives in expectedOutflow name; not a clamp (no sign discarded to hide value)
        const positiveAmount = amount < 0n ? -amount : amount;
        let dayItems = daysMap.get(dateStr);
        if (!dayItems) {
          dayItems = [];
          daysMap.set(dateStr, dayItems);
        }
        dayItems.push({
          ...movement,
          refId: row.refId,
          label: row.label,
          amountMinor: positiveAmount,
          state: 'scheduled',
        });
      } else {
        if (row.amountMinor === null || row.amountMinor === undefined) {
          countedUnreadableTemplate += 1;
          continue;
        }
        let amount: bigint;
        if (typeof row.amountMinor === 'bigint') {
          amount = row.amountMinor;
        } else if (
          typeof row.amountMinor === 'string' &&
          INTEGER_AMOUNT_PATTERN.test(row.amountMinor)
        ) {
          amount = BigInt(row.amountMinor);
        } else {
          countedUnreadableTemplate += 1;
          continue;
        }
        // Positive magnitude: direction lives in expectedOutflow name; not a clamp (no sign discarded to hide value)
        const positiveAmount = amount < 0n ? -amount : amount;
        let dayItems = daysMap.get(dateStr);
        if (!dayItems) {
          dayItems = [];
          daysMap.set(dateStr, dayItems);
        }
        dayItems.push({
          kind: row.kind,
          refId: row.refId,
          label: row.label,
          amountMinor: positiveAmount,
          state: 'scheduled',
          direction: 'outflow',
        });
      }
    }
  }

  // Deterministic order: days ascending by date
  const sortedDates = [...daysMap.keys()].sort((a, b) => a.localeCompare(b));

  const days: FinancialCalendarDay[] = [];

  for (const date of sortedDates) {
    const items = daysMap.get(date)!;
    // Deterministic order: within a day, items ascending by kind, then refId
    items.sort((a, b) => {
      const kindCmp = a.kind.localeCompare(b.kind);
      if (kindCmp !== 0) {
        return kindCmp;
      }
      return a.refId.localeCompare(b.refId);
    });

    let expectedOutflowMinor = 0n;
    let expectedInflowMinor = 0n;
    for (const item of items) {
      if (item.state !== 'scheduled' || item.amountMinor === null) continue;
      if (item.direction === 'outflow')
        expectedOutflowMinor += item.amountMinor;
      if (item.direction === 'inflow') expectedInflowMinor += item.amountMinor;
    }
    days.push({ date, expectedOutflowMinor, expectedInflowMinor, items });
  }

  // Derived from days, so the total cannot diverge from its parts by construction.
  // This replaces a runtime invariant check: an impossible state is better than a guarded one.
  const totalExpectedOutflowMinor = days.reduce(
    (sum, day) => sum + day.expectedOutflowMinor,
    0n,
  );

  return {
    periodStart: from,
    periodEnd: to,
    days,
    totalExpectedOutflowMinor,
    totalExpectedInflowMinor: days.reduce(
      (sum, day) => sum + day.expectedInflowMinor,
      0n,
    ),
    debtsWithoutScheduledAmount:
      debtsWithoutScheduledAmount + countedDebtsWithoutScheduledAmount,
    recurringRulesWithUnreadableTemplate:
      unreadableTemplateCount + countedUnreadableTemplate,
  };
}

/**
 * §3.2 buildBalanceProjection
 * Pure builder that extrapolates balance based on historical monthly capacity.
 *
 * Design constraints:
 * - Extrapolation rule: flat-mean extrapolation based on history.
 * - meanMonthlyIncomeMinor and meanMonthlyExpensesMinor are half-away-from-zero
 *   integer means over history, calculated via roundDivHalfAwayFromZero.
 * - When basisMonths === 0, both means are 0n and projection is flat (no division by zero).
 * - Month buckets: gap-free in order via generateBucketPeriods(from, to, GRANULARITY.MONTH).
 * - projectedBalanceMinor is a running total: openingBalance + (meanIncome - meanExpenses)
 *   compounded month by month.
 * - Nothing is clamped: negative projected balances stay negative.
 * - Note on scheduled outflows: Do NOT fold financial_calendar's scheduled outflows into the
 *   projection. The historical mean already accounts for regular recurring charges and debts,
 *   so adding scheduled calendar outflows on top would double-count them.
 */
export function buildBalanceProjection(
  from: string,
  to: string,
  openingBalanceMinor: bigint,
  history: readonly MonthlyCapacityPoint[],
): BalanceProjection {
  const basisMonths = history.length;
  let meanMonthlyIncomeMinor = 0n;
  let meanMonthlyExpensesMinor = 0n;

  if (basisMonths > 0) {
    let sumIncomeMinor = 0n;
    let sumExpensesMinor = 0n;
    for (const point of history) {
      sumIncomeMinor += point.incomeMinor;
      sumExpensesMinor += point.expensesMinor;
    }
    const divisor = BigInt(basisMonths);
    meanMonthlyIncomeMinor = roundDivHalfAwayFromZero(sumIncomeMinor, divisor);
    meanMonthlyExpensesMinor = roundDivHalfAwayFromZero(
      sumExpensesMinor,
      divisor,
    );
  }

  const bucketPeriods = generateBucketPeriods(from, to, GRANULARITY.MONTH);
  const netMonthlyFlow = meanMonthlyIncomeMinor - meanMonthlyExpensesMinor;

  let runningBalance = openingBalanceMinor;
  const months: BalanceProjectionPoint[] = [];

  for (const month of bucketPeriods) {
    runningBalance += netMonthlyFlow;
    // Nothing is clamped: if runningBalance becomes negative, it remains negative
    months.push({
      month,
      expectedInflowMinor: meanMonthlyIncomeMinor,
      expectedOutflowMinor: meanMonthlyExpensesMinor,
      projectedBalanceMinor: runningBalance,
    });
  }

  return {
    openingBalanceMinor,
    basisMonths,
    meanMonthlyIncomeMinor,
    meanMonthlyExpensesMinor,
    months,
  };
}
