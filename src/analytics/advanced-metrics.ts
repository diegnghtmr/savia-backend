import {
  GRANULARITY,
  type ConvertedFlowRow,
  type MonthlyCapacityPoint,
} from './analytics.port.js';
import {
  generateBucketPeriods,
  truncateToBucketStart,
} from './analytics.service.js';

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
