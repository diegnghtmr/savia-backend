export const GRANULARITY = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
} as const;

export type Granularity = (typeof GRANULARITY)[keyof typeof GRANULARITY];

export interface ConvertedFlowRow {
  readonly type: 'income' | 'expense' | 'refund';
  readonly amountMinor: bigint;
  readonly occurredAt: Date;
}

export interface MonthlyCapacityPoint {
  readonly month: string;
  readonly incomeMinor: bigint;
  readonly expensesMinor: bigint;
  readonly savingsCapacityMinor: bigint;
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
