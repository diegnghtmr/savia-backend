import {
  GRANULARITY,
  type ConvertedFlowRow,
  type ConvertedSubscriptionRow,
  type IncomeStability,
  type MonthlyCapacityPoint,
  type QuarterlyAveragePoint,
  type RecurringVsVariable,
  type SubscriptionPriceIncreaseItem,
  type SubscriptionPriceIncreases,
  type SubscriptionPriceRow,
  type WeekdayHeatmapPoint,
} from './analytics.port.js';
import {
  generateBucketPeriods,
  truncateToBucketStart,
} from './analytics.service.js';
import { computeIncreasePercent } from '../recurring/subscription-calculation.js';

interface BucketAccumulator {
  incomeMinor: bigint;
  expensesMinor: bigint;
}

/**
 * §3.3 buildMonthlySavingsCapacity
 * Pure builder that calculates monthly savings capacity series.
 * - Buckets: every calendar month from month containing `from` to month containing `to`,
 *   inclusive, gap-free and zero-filled.
 * - A row lands in the month of `occurredAt` evaluated in UTC.
 * - Classification (§3.2):
 *   - income adds to income
 *   - expense adds to expenses
 *   - refund subtracts from expenses
 *   - savingsCapacity = income - expenses
 * - savingsCapacity and expenses MAY BE NEGATIVE. NEVER clamp either to zero.
 * - Order: ascending by month. Deterministic.
 */
export function buildMonthlySavingsCapacity(
  from: string,
  to: string,
  rows: readonly ConvertedFlowRow[],
): readonly MonthlyCapacityPoint[] {
  // Reuse generateBucketPeriods(from, to, GRANULARITY.MONTH) per §3.3
  const bucketPeriods = generateBucketPeriods(from, to, GRANULARITY.MONTH);

  const bucketMap = new Map<string, BucketAccumulator>();
  for (const period of bucketPeriods) {
    bucketMap.set(period, { incomeMinor: 0n, expensesMinor: 0n });
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

    if (row.type === 'income') {
      bucket.incomeMinor += row.amountMinor;
    } else if (row.type === 'expense') {
      bucket.expensesMinor += row.amountMinor;
    } else if (row.type === 'refund') {
      bucket.expensesMinor -= row.amountMinor;
    }
  }

  return bucketPeriods.map((month) => {
    const bucket = bucketMap.get(month)!;
    return {
      month,
      incomeMinor: bucket.incomeMinor,
      expensesMinor: bucket.expensesMinor,
      // §3.2 savingsCapacity = income - expenses; may be negative, never clamp
      savingsCapacityMinor: bucket.incomeMinor - bucket.expensesMinor,
    };
  });
}

/**
 * Integer division with half-away-from-zero (symmetric half-up) rounding.
 * Reuses the same tie-breaking logic as computeIncreasePercent in src/recurring/subscription-calculation.ts.
 */
export function roundDivHalfAwayFromZero(num: bigint, den: bigint): bigint {
  if (den === 0n) {
    throw new Error('Division by zero in roundDivHalfAwayFromZero');
  }
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  if (n >= 0n) {
    if (2n * r >= d) {
      return q + 1n;
    }
    return q;
  } else {
    const absR = -r;
    if (2n * absR >= d) {
      return q - 1n;
    }
    return q;
  }
}

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
): IncomeStability {
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
 *   - null for first quarter in series
 *   - null when previous quarter average is 0
 *   - uses |previous| in denominator
 * - Order: ascending by quarter. Deterministic.
 */
export function buildQuarterlyAverageComparison(
  monthlySeries: readonly MonthlyCapacityPoint[],
): readonly QuarterlyAveragePoint[] {
  if (monthlySeries.length === 0) {
    return [];
  }

  // Group monthly points by calendar quarter (YYYY-Qn)
  const quarterGroups = new Map<string, MonthlyCapacityPoint[]>();
  for (const point of monthlySeries) {
    const year = point.month.slice(0, 4);
    const monthNum = parseInt(point.month.slice(5, 7), 10);
    const quarterNum = Math.floor((monthNum - 1) / 3) + 1;
    const quarterKey = `${year}-Q${quarterNum}`;

    let group = quarterGroups.get(quarterKey);
    if (!group) {
      group = [];
      quarterGroups.set(quarterKey, group);
    }
    group.push(point);
  }

  // Deterministic ascending quarter ordering
  const sortedQuarters = [...quarterGroups.keys()].sort((a, b) =>
    a.localeCompare(b),
  );

  const results: QuarterlyAveragePoint[] = [];

  for (let i = 0; i < sortedQuarters.length; i += 1) {
    const quarter = sortedQuarters[i];
    const points = quarterGroups.get(quarter)!;
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
    if (i > 0) {
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
 * - increasePercent computed with computeIncreasePercent from src/recurring/subscription-calculation.ts.
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
    const key = sub.frequency.trim().toLowerCase();
    const perYear = FREQUENCY_PER_YEAR[key];

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
    committedPercent = Object.is(pct, -0) ? 0 : pct;
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
