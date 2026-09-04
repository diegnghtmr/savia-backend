import { describe, expect, it } from 'vitest';
import type {
  ConvertedDebtCostRow,
  ConvertedFlowRow,
  ConvertedSubscriptionRow,
  MonthlyCapacityPoint,
  SubscriptionPriceRow,
} from '../../src/analytics/analytics.port.js';
import {
  bigintSqrt,
  buildDebtCostEvolution,
  buildIncomeStability,
  buildMonthlySavingsCapacity,
  buildQuarterlyAverageComparison,
  buildRecurringVsVariable,
  buildSubscriptionPriceIncreases,
  buildWeekdayHeatmap,
} from '../../src/analytics/advanced-metrics.js';
import { computeIncreasePercent } from '../../src/recurring/subscription-calculation.js';

describe('bigintSqrt', () => {
  it('computes exact square root for perfect squares (0n, 1n, 4n, 10000n)', () => {
    expect(bigintSqrt(0n)).toBe(0n);
    expect(bigintSqrt(1n)).toBe(1n);
    expect(bigintSqrt(4n)).toBe(2n);
    expect(bigintSqrt(10000n)).toBe(100n);
  });

  it('computes floor square root for non-squares (2n -> 1n, 8n -> 2n, 99n -> 9n)', () => {
    expect(bigintSqrt(2n)).toBe(1n);
    expect(bigintSqrt(8n)).toBe(2n);
    expect(bigintSqrt(99n)).toBe(9n);
  });

  it('computes exact square root for very large values (10n**30n -> 10n**15n)', () => {
    expect(bigintSqrt(10n ** 30n)).toBe(10n ** 15n);
  });

  it('throws on negative input', () => {
    expect(() => bigintSqrt(-1n)).toThrow();
  });
});

describe('buildMonthlySavingsCapacity', () => {
  it('returns zero-filled buckets over a real period when input is empty', () => {
    const from = '2026-01-01';
    const to = '2026-03-31';
    const rows: readonly ConvertedFlowRow[] = [];

    const result = buildMonthlySavingsCapacity(from, to, rows);

    expect(result).toEqual([
      {
        month: '2026-01-01',
        incomeMinor: 0n,
        expensesMinor: 0n,
        savingsCapacityMinor: 0n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 0n,
        expensesMinor: 0n,
        savingsCapacityMinor: 0n,
      },
      {
        month: '2026-03-01',
        incomeMinor: 0n,
        expensesMinor: 0n,
        savingsCapacityMinor: 0n,
      },
    ]);
  });

  it('correctly calculates a month with income only and a month with expenses only', () => {
    const from = '2026-01-01';
    const to = '2026-02-28';
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'income',
        amountMinor: 50000n,
        occurredAt: new Date('2026-01-15T10:00:00Z'),
      },
      {
        type: 'expense',
        amountMinor: 20000n,
        occurredAt: new Date('2026-02-10T15:00:00Z'),
      },
    ];

    const result = buildMonthlySavingsCapacity(from, to, rows);

    expect(result).toEqual([
      {
        month: '2026-01-01',
        incomeMinor: 50000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 50000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 0n,
        expensesMinor: 20000n,
        savingsCapacityMinor: -20000n,
      },
    ]);
  });

  it('preserves negative savings capacity when expenses exceed income without clamping', () => {
    const from = '2026-04-01';
    const to = '2026-04-30';
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'income',
        amountMinor: 10000n,
        occurredAt: new Date('2026-04-05T00:00:00Z'),
      },
      {
        type: 'expense',
        amountMinor: 35000n,
        occurredAt: new Date('2026-04-10T00:00:00Z'),
      },
    ];

    const result = buildMonthlySavingsCapacity(from, to, rows);

    expect(result).toEqual([
      {
        month: '2026-04-01',
        incomeMinor: 10000n,
        expensesMinor: 35000n,
        savingsCapacityMinor: -25000n,
      },
    ]);
    expect(result[0].savingsCapacityMinor).toBe(-25000n);
  });

  it('preserves negative net expenses when refunds exceed expenses without clamping', () => {
    const from = '2026-05-01';
    const to = '2026-05-31';
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'income',
        amountMinor: 10000n,
        occurredAt: new Date('2026-05-01T00:00:00Z'),
      },
      {
        type: 'expense',
        amountMinor: 5000n,
        occurredAt: new Date('2026-05-10T00:00:00Z'),
      },
      {
        type: 'refund',
        amountMinor: 15000n,
        occurredAt: new Date('2026-05-15T00:00:00Z'),
      },
    ];

    const result = buildMonthlySavingsCapacity(from, to, rows);

    expect(result).toEqual([
      {
        month: '2026-05-01',
        incomeMinor: 10000n,
        expensesMinor: -10000n,
        savingsCapacityMinor: 20000n,
      },
    ]);
    expect(result[0].expensesMinor).toBe(-10000n);
    expect(result[0].savingsCapacityMinor).toBe(20000n);
  });

  it('correctly assigns transactions on UTC boundaries to their respective months', () => {
    const from = '2026-01-01';
    const to = '2026-02-28';
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'income',
        amountMinor: 1000n,
        occurredAt: new Date('2026-01-31T23:59:59.999Z'),
      },
      {
        type: 'income',
        amountMinor: 2000n,
        occurredAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    ];

    const result = buildMonthlySavingsCapacity(from, to, rows);

    expect(result).toEqual([
      {
        month: '2026-01-01',
        incomeMinor: 1000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 1000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 2000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 2000n,
      },
    ]);
  });
});

describe('buildIncomeStability', () => {
  it('returns zeroed metrics and null CV when monthly series is empty', () => {
    const series: readonly MonthlyCapacityPoint[] = [];

    const result = buildIncomeStability(series);

    expect(result).toEqual({
      monthsCounted: 0,
      meanMonthlyIncomeMinor: 0n,
      minMonthlyIncomeMinor: 0n,
      maxMonthlyIncomeMinor: 0n,
      coefficientOfVariationPercent: null,
    });
  });

  it('returns CV of 0 for a single-month period', () => {
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 50000n,
        expensesMinor: 20000n,
        savingsCapacityMinor: 30000n,
      },
    ];

    const result = buildIncomeStability(series);

    expect(result).toEqual({
      monthsCounted: 1,
      meanMonthlyIncomeMinor: 50000n,
      minMonthlyIncomeMinor: 50000n,
      maxMonthlyIncomeMinor: 50000n,
      coefficientOfVariationPercent: 0,
    });
  });

  it('returns null CV when mean monthly income is exactly zero', () => {
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 0n,
        expensesMinor: 10000n,
        savingsCapacityMinor: -10000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 0n,
        expensesMinor: 15000n,
        savingsCapacityMinor: -15000n,
      },
    ];

    const result = buildIncomeStability(series);

    expect(result).toEqual({
      monthsCounted: 2,
      meanMonthlyIncomeMinor: 0n,
      minMonthlyIncomeMinor: 0n,
      maxMonthlyIncomeMinor: 0n,
      coefficientOfVariationPercent: null,
    });
  });

  it('reports a non-negative CV when mean monthly income is negative', () => {
    // A coefficient of variation is a dispersion RATIO: stdDev / |mean|. Standard
    // deviation is never negative, so the CV must never be negative either. Monthly
    // income can go negative because AmountMinor is a signed integer in the contract
    // and an income correction is recorded as a negative income transaction.
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: -10000n,
        expensesMinor: 0n,
        savingsCapacityMinor: -10000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: -30000n,
        expensesMinor: 0n,
        savingsCapacityMinor: -30000n,
      },
    ];

    const result = buildIncomeStability(series);

    // mean = -20000, population stdDev = 10000, so the spread is 50% of the magnitude.
    expect(result.meanMonthlyIncomeMinor).toBe(-20000n);
    expect(result.coefficientOfVariationPercent).toBe(50);
  });

  it('calculates mean, min, max and CV% with population std dev rounded to 2 decimals', () => {
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 100000n,
        expensesMinor: 50000n,
        savingsCapacityMinor: 50000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 200000n,
        expensesMinor: 80000n,
        savingsCapacityMinor: 120000n,
      },
      {
        month: '2026-03-01',
        incomeMinor: 150000n,
        expensesMinor: 60000n,
        savingsCapacityMinor: 90000n,
      },
    ];

    const result = buildIncomeStability(series);

    expect(result).toEqual({
      monthsCounted: 3,
      meanMonthlyIncomeMinor: 150000n,
      minMonthlyIncomeMinor: 100000n,
      maxMonthlyIncomeMinor: 200000n,
      coefficientOfVariationPercent: 27.22,
    });
  });

  it('applies half-away-from-zero rounding to mean monthly income', () => {
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 10000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 10000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 10001n,
        expensesMinor: 0n,
        savingsCapacityMinor: 10001n,
      },
    ];

    const result = buildIncomeStability(series);

    // Sum is 20001n / 2n = 10000.5n -> rounds away from zero to 10001n
    expect(result.meanMonthlyIncomeMinor).toBe(10001n);
  });

  it('returns CV exactly 0 when all months have identical income (S === 0n)', () => {
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 50000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 50000n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 50000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 50000n,
      },
      {
        month: '2026-03-01',
        incomeMinor: 50000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 50000n,
      },
    ];

    const result = buildIncomeStability(series);

    expect(result.coefficientOfVariationPercent).toBe(0);
  });

  it('correctly rounds exact tie half-away-from-zero on first inversion regression vector (33.335 -> 33.34)', () => {
    // Exact CV is 33.335%; half-away-from-zero requires rounding up to 33.34%.
    // Floating-point math previously misrounded this down to 33.33%.
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 6276689609128780284n,
        expensesMinor: 0n,
        savingsCapacityMinor: 6276689609128780284n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 3138227118105299716n,
        expensesMinor: 0n,
        savingsCapacityMinor: 3138227118105299716n,
      },
    ];

    const result = buildIncomeStability(series);

    expect(result.coefficientOfVariationPercent).toBe(33.34);
  });

  it('correctly rounds strictly-below-tie half-away-from-zero on second inversion regression vector (33.334999... -> 33.33)', () => {
    // Exact CV is 33.33499999999999999...%; strictly below the 33.335 tie, requires rounding to 33.33%.
    // Floating-point math with a 1e-12 fudge previously misrounded this up to 33.34%.
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 8666775000000001535n,
        expensesMinor: 0n,
        savingsCapacityMinor: 8666775000000001535n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 4333225000000000768n,
        expensesMinor: 0n,
        savingsCapacityMinor: 4333225000000000768n,
      },
    ];

    const result = buildIncomeStability(series);

    expect(result.coefficientOfVariationPercent).toBe(33.33);
  });
});

describe('buildQuarterlyAverageComparison', () => {
  it('correctly reports monthsCounted for clipped partial quarters', () => {
    // Period starting mid-quarter (Feb) and ending mid-quarter (Jul)
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-02-01',
        incomeMinor: 20000n,
        expensesMinor: 10000n,
        savingsCapacityMinor: 10000n,
      },
      {
        month: '2026-03-01',
        incomeMinor: 30000n,
        expensesMinor: 10000n,
        savingsCapacityMinor: 20000n,
      },
      {
        month: '2026-04-01',
        incomeMinor: 10000n,
        expensesMinor: 5000n,
        savingsCapacityMinor: 5000n,
      },
      {
        month: '2026-05-01',
        incomeMinor: 10000n,
        expensesMinor: 5000n,
        savingsCapacityMinor: 5000n,
      },
      {
        month: '2026-06-01',
        incomeMinor: 10000n,
        expensesMinor: 5000n,
        savingsCapacityMinor: 5000n,
      },
      {
        month: '2026-07-01',
        incomeMinor: 40000n,
        expensesMinor: 20000n,
        savingsCapacityMinor: 20000n,
      },
    ];

    const result = buildQuarterlyAverageComparison(series);

    expect(result).toHaveLength(3);
    // Q1 has 2 months counted (Feb, Mar)
    expect(result[0].quarter).toBe('2026-Q1');
    expect(result[0].monthsCounted).toBe(2);
    expect(result[0].averageMonthlyIncomeMinor).toBe(25000n); // (20000 + 30000) / 2
    expect(result[0].averageMonthlyExpensesMinor).toBe(10000n);
    expect(result[0].averageMonthlySavingsCapacityMinor).toBe(15000n);
    expect(result[0].savingsCapacityDeltaPercentVsPreviousQuarter).toBeNull();

    // Q2 has 3 months counted (Apr, May, Jun)
    expect(result[1].quarter).toBe('2026-Q2');
    expect(result[1].monthsCounted).toBe(3);
    expect(result[1].averageMonthlyIncomeMinor).toBe(10000n);
    expect(result[1].averageMonthlyExpensesMinor).toBe(5000n);
    expect(result[1].averageMonthlySavingsCapacityMinor).toBe(5000n);
    // Delta vs Q1: ((5000 - 15000) / 15000) * 100 = -66.67%
    expect(result[1].savingsCapacityDeltaPercentVsPreviousQuarter).toBe(-66.67);

    // Q3 has 1 month counted (Jul)
    expect(result[2].quarter).toBe('2026-Q3');
    expect(result[2].monthsCounted).toBe(1);
    expect(result[2].averageMonthlyIncomeMinor).toBe(40000n);
    expect(result[2].averageMonthlyExpensesMinor).toBe(20000n);
    expect(result[2].averageMonthlySavingsCapacityMinor).toBe(20000n);
    // Delta vs Q2: ((20000 - 5000) / 5000) * 100 = +300%
    expect(result[2].savingsCapacityDeltaPercentVsPreviousQuarter).toBe(300);
  });

  it('returns null delta when previous quarter average savings capacity is exactly 0', () => {
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 10000n,
        expensesMinor: 10000n,
        savingsCapacityMinor: 0n,
      },
      {
        month: '2026-04-01',
        incomeMinor: 20000n,
        expensesMinor: 10000n,
        savingsCapacityMinor: 10000n,
      },
    ];

    const result = buildQuarterlyAverageComparison(series);

    expect(result).toHaveLength(2);
    expect(result[0].savingsCapacityDeltaPercentVsPreviousQuarter).toBeNull();
    expect(result[1].savingsCapacityDeltaPercentVsPreviousQuarter).toBeNull();
  });

  it('produces positive delta when transitioning from negative to less-negative quarter', () => {
    // §3.5: Move from -100 to -50 reads as improvement (+50%), not decline
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 0n,
        expensesMinor: 100n,
        savingsCapacityMinor: -100n,
      },
      {
        month: '2026-04-01',
        incomeMinor: 0n,
        expensesMinor: 50n,
        savingsCapacityMinor: -50n,
      },
    ];

    const result = buildQuarterlyAverageComparison(series);

    expect(result).toHaveLength(2);
    expect(result[0].averageMonthlySavingsCapacityMinor).toBe(-100n);
    expect(result[1].averageMonthlySavingsCapacityMinor).toBe(-50n);
    expect(result[1].savingsCapacityDeltaPercentVsPreviousQuarter).toBe(50);
  });

  it('applies half-away-from-zero rounding to both positive (up) and negative (away from zero) cases', () => {
    // Positive round up: 5n / 2n = 2.5n -> 3n
    // Negative round away from zero (down): -5n / 2n = -2.5n -> -3n
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01',
        incomeMinor: 3n,
        expensesMinor: 4n,
        savingsCapacityMinor: -1n,
      },
      {
        month: '2026-02-01',
        incomeMinor: 2n,
        expensesMinor: 6n,
        savingsCapacityMinor: -4n,
      },
    ];

    const result = buildQuarterlyAverageComparison(series);

    expect(result).toHaveLength(1);
    // income: (3 + 2) / 2 = 2.5 -> 3n
    expect(result[0].averageMonthlyIncomeMinor).toBe(3n);
    // expenses: (4 + 6) / 2 = 5n
    expect(result[0].averageMonthlyExpensesMinor).toBe(5n);
    // savings: (-1 + -4) / 2 = -2.5 -> -3n (away from zero / down)
    expect(result[0].averageMonthlySavingsCapacityMinor).toBe(-3n);
  });

  it('sorts quarters chronologically and computes delta vs chronological predecessor when input months are out of order', () => {
    // Non-chronological input: Q3 first, then Q1, then Q2
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-07-01', // Q3
        incomeMinor: 40000n,
        expensesMinor: 20000n,
        savingsCapacityMinor: 20000n,
      },
      {
        month: '2026-01-01', // Q1
        incomeMinor: 20000n,
        expensesMinor: 10000n,
        savingsCapacityMinor: 10000n,
      },
      {
        month: '2026-04-01', // Q2
        incomeMinor: 10000n,
        expensesMinor: 5000n,
        savingsCapacityMinor: 5000n,
      },
    ];

    const result = buildQuarterlyAverageComparison(series);

    expect(result.map((point) => point.quarter)).toEqual([
      '2026-Q1',
      '2026-Q2',
      '2026-Q3',
    ]);
    expect(result[0].savingsCapacityDeltaPercentVsPreviousQuarter).toBeNull();
    expect(
      result[1].savingsCapacityDeltaPercentVsPreviousQuarter,
    ).not.toBeNull();
    expect(
      result[2].savingsCapacityDeltaPercentVsPreviousQuarter,
    ).not.toBeNull();
  });

  it('applies half-away-from-zero rounding on exact half tie boundaries for quarterly delta in both positive and negative directions', () => {
    // Hand derivation of tie boundaries (both landing on an exact half hundredth, i.e., ±0.025%):
    // 1. Positive tie:
    //    previous = 8000n, current = 8002n
    //    delta = 8002 - 8000 = +2
    //    delta% = (2 / 8000) * 100 = 2 / 80 = 0.025%
    //    In hundredths (basis points): 0.025 * 100 = 2.5 hundredths
    //    Integer arithmetic: num = 2 * 10000 = 20000n, den = 8000n
    //    q = 20000 / 8000 = 2n, r = 20000 % 8000 = 4000n
    //    2 * r = 8000n === den -> exact tie at 0.5 hundredths
    //    Half-away-from-zero rounds 2.5 up to 3 hundredths -> +0.03%
    //    (Strictly greater `>` would truncate to 2 hundredths -> +0.02%)
    //
    // 2. Negative tie:
    //    previous = 8000n, current = 7998n
    //    delta = 7998 - 8000 = -2
    //    delta% = (-2 / 8000) * 100 = -2 / 80 = -0.025%
    //    In hundredths (basis points): -0.025 * 100 = -2.5 hundredths
    //    Integer arithmetic: num = -2 * 10000 = -20000n, den = 8000n
    //    q = -20000 / 8000 = -2n, r = -20000 % 8000 = -4000n
    //    2 * |r| = 8000n === den -> exact tie at -0.5 hundredths
    //    Half-away-from-zero rounds -2.5 away from zero to -3 hundredths -> -0.03%
    //    (Strictly greater `>` would truncate toward zero to -2 hundredths -> -0.02%)
    const series: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-01-01', // Q1: savings 8000n
        incomeMinor: 8000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 8000n,
      },
      {
        month: '2026-04-01', // Q2: savings 8002n (delta vs Q1: +0.025% -> +0.03)
        incomeMinor: 8002n,
        expensesMinor: 0n,
        savingsCapacityMinor: 8002n,
      },
      {
        month: '2026-07-01', // Q3: savings 8000n
        incomeMinor: 8000n,
        expensesMinor: 0n,
        savingsCapacityMinor: 8000n,
      },
      {
        month: '2026-10-01', // Q4: savings 7998n (delta vs Q3: -0.025% -> -0.03)
        incomeMinor: 7998n,
        expensesMinor: 0n,
        savingsCapacityMinor: 7998n,
      },
    ];

    const result = buildQuarterlyAverageComparison(series);

    expect(result).toHaveLength(4);
    expect(result[1].savingsCapacityDeltaPercentVsPreviousQuarter).toBe(0.03);
    expect(result[3].savingsCapacityDeltaPercentVsPreviousQuarter).toBe(-0.03);
  });
});

describe('buildWeekdayHeatmap', () => {
  it('returns all 7 weekdays present and zero-filled when only one weekday has data', () => {
    // 2026-01-07 is Wednesday (weekday 3 in ISO-8601: Mon=1, Tue=2, Wed=3...)
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'expense',
        amountMinor: 5000n,
        occurredAt: new Date('2026-01-07T12:00:00Z'),
      },
    ];

    const result = buildWeekdayHeatmap(rows);

    expect(result).toHaveLength(7);
    expect(result.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result[0]).toEqual({
      weekday: 1,
      transactionCount: 0,
      totalMinor: 0n,
    });
    expect(result[1]).toEqual({
      weekday: 2,
      transactionCount: 0,
      totalMinor: 0n,
    });
    expect(result[2]).toEqual({
      weekday: 3,
      transactionCount: 1,
      totalMinor: 5000n,
    });
    expect(result[3]).toEqual({
      weekday: 4,
      transactionCount: 0,
      totalMinor: 0n,
    });
    expect(result[4]).toEqual({
      weekday: 5,
      transactionCount: 0,
      totalMinor: 0n,
    });
    expect(result[5]).toEqual({
      weekday: 6,
      transactionCount: 0,
      totalMinor: 0n,
    });
    expect(result[6]).toEqual({
      weekday: 7,
      transactionCount: 0,
      totalMinor: 0n,
    });
  });

  it('adds expenses, subtracts refunds, and completely excludes income', () => {
    // 2026-01-05 is Monday (weekday 1)
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'expense',
        amountMinor: 10000n,
        occurredAt: new Date('2026-01-05T09:00:00Z'),
      },
      {
        type: 'refund',
        amountMinor: 3000n,
        occurredAt: new Date('2026-01-05T14:00:00Z'),
      },
      {
        type: 'income',
        amountMinor: 50000n,
        occurredAt: new Date('2026-01-05T18:00:00Z'),
      },
    ];

    const result = buildWeekdayHeatmap(rows);

    // Monday should have 2 transactions (expense + refund), income excluded
    // totalMinor = 10000 - 3000 = 7000n
    expect(result[0]).toEqual({
      weekday: 1,
      transactionCount: 2,
      totalMinor: 7000n,
    });
  });

  it('reports real transaction count when expense and refund cancel to zero', () => {
    // 2026-01-06 is Tuesday (weekday 2)
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'expense',
        amountMinor: 5000n,
        occurredAt: new Date('2026-01-06T10:00:00Z'),
      },
      {
        type: 'refund',
        amountMinor: 5000n,
        occurredAt: new Date('2026-01-06T15:00:00Z'),
      },
    ];

    const result = buildWeekdayHeatmap(rows);

    expect(result[1]).toEqual({
      weekday: 2,
      transactionCount: 2,
      totalMinor: 0n,
    });
  });

  it('correctly assigns weekday across UTC boundary', () => {
    // 2026-01-04 is Sunday (weekday 7)
    // 2026-01-04T23:59:59.999Z is Sunday -> weekday 7
    // 2026-01-05T00:00:00.000Z is Monday -> weekday 1
    const rows: readonly ConvertedFlowRow[] = [
      {
        type: 'expense',
        amountMinor: 1000n,
        occurredAt: new Date('2026-01-04T23:59:59.999Z'),
      },
      {
        type: 'expense',
        amountMinor: 2000n,
        occurredAt: new Date('2026-01-05T00:00:00.000Z'),
      },
    ];

    const result = buildWeekdayHeatmap(rows);

    // Monday (index 0)
    expect(result[0].weekday).toBe(1);
    expect(result[0].transactionCount).toBe(1);
    expect(result[0].totalMinor).toBe(2000n);

    // Sunday (index 6)
    expect(result[6].weekday).toBe(7);
    expect(result[6].transactionCount).toBe(1);
    expect(result[6].totalMinor).toBe(1000n);
  });
});

describe('buildSubscriptionPriceIncreases', () => {
  it('counts a subscription whose currency differs from its previous amount in excludedForCurrencyMismatch', () => {
    const rows: readonly SubscriptionPriceRow[] = [
      {
        id: 'sub-1',
        payeeName: 'GitHub',
        currentAmountMinor: '1200',
        currentCurrency: 'USD',
        previousAmountMinor: '1000',
        previousCurrency: 'EUR',
      },
    ];

    const result = buildSubscriptionPriceIncreases(rows);

    expect(result).toEqual({
      items: [],
      consideredCount: 1,
      decreasedOrUnchangedCount: 0,
      excludedForCurrencyMismatch: 1,
      excludedForZeroPrevious: 0,
    });
  });

  it('counts a subscription whose previous amount is 0 in excludedForZeroPrevious', () => {
    const rows: readonly SubscriptionPriceRow[] = [
      {
        id: 'sub-2',
        payeeName: 'Figma',
        currentAmountMinor: '1500',
        currentCurrency: 'USD',
        previousAmountMinor: '0',
        previousCurrency: 'USD',
      },
    ];

    const result = buildSubscriptionPriceIncreases(rows);

    expect(result).toEqual({
      items: [],
      consideredCount: 1,
      decreasedOrUnchangedCount: 0,
      excludedForCurrencyMismatch: 0,
      excludedForZeroPrevious: 1,
    });
  });

  it('counts a price decrease in decreasedOrUnchangedCount and excludes it from items', () => {
    const rows: readonly SubscriptionPriceRow[] = [
      {
        id: 'sub-3',
        payeeName: 'AWS',
        currentAmountMinor: '8000',
        currentCurrency: 'USD',
        previousAmountMinor: '10000',
        previousCurrency: 'USD',
      },
      {
        id: 'sub-4',
        payeeName: 'DigitalOcean',
        currentAmountMinor: '2000',
        currentCurrency: 'USD',
        previousAmountMinor: '2000',
        previousCurrency: 'USD',
      },
    ];

    const result = buildSubscriptionPriceIncreases(rows);

    expect(result.items).toHaveLength(0);
    expect(result.consideredCount).toBe(2);
    expect(result.decreasedOrUnchangedCount).toBe(2);
    expect(result.excludedForCurrencyMismatch).toBe(0);
    expect(result.excludedForZeroPrevious).toBe(0);
  });

  it('breaks ordering ties deterministically by payeeName ascending then subscriptionId ascending', () => {
    const rows: readonly SubscriptionPriceRow[] = [
      {
        id: 'sub-c',
        payeeName: 'Zendesk',
        currentAmountMinor: '2000',
        currentCurrency: 'USD',
        previousAmountMinor: '1000',
        previousCurrency: 'USD',
      },
      {
        id: 'sub-b',
        payeeName: 'Acme Corp',
        currentAmountMinor: '2000',
        currentCurrency: 'USD',
        previousAmountMinor: '1000',
        previousCurrency: 'USD',
      },
      {
        id: 'sub-a',
        payeeName: 'Acme Corp',
        currentAmountMinor: '4000',
        currentCurrency: 'USD',
        previousAmountMinor: '2000',
        previousCurrency: 'USD',
      },
    ];

    // All three have increasePercent = +100%.
    // Tie-break rule: payeeName asc ('Acme Corp' before 'Zendesk'), then subscriptionId asc ('sub-a' before 'sub-b')
    const result = buildSubscriptionPriceIncreases(rows);

    expect(result.consideredCount).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({
      subscriptionId: 'sub-a',
      payeeName: 'Acme Corp',
      previousAmount: { amountMinor: '2000', currency: 'USD' },
      currentAmount: { amountMinor: '4000', currency: 'USD' },
      increasePercent: 100,
    });
    expect(result.items[1]).toEqual({
      subscriptionId: 'sub-b',
      payeeName: 'Acme Corp',
      previousAmount: { amountMinor: '1000', currency: 'USD' },
      currentAmount: { amountMinor: '2000', currency: 'USD' },
      increasePercent: 100,
    });
    expect(result.items[2]).toEqual({
      subscriptionId: 'sub-c',
      payeeName: 'Zendesk',
      previousAmount: { amountMinor: '1000', currency: 'USD' },
      currentAmount: { amountMinor: '2000', currency: 'USD' },
      increasePercent: 100,
    });
  });

  it('includes price increases in items ordered by increasePercent descending', () => {
    const rows: readonly SubscriptionPriceRow[] = [
      {
        id: 'sub-10',
        payeeName: 'Service A',
        currentAmountMinor: '1100',
        currentCurrency: 'USD',
        previousAmountMinor: '1000',
        previousCurrency: 'USD',
      }, // +10%
      {
        id: 'sub-20',
        payeeName: 'Service B',
        currentAmountMinor: '1500',
        currentCurrency: 'USD',
        previousAmountMinor: '1000',
        previousCurrency: 'USD',
      }, // +50%
      {
        id: 'sub-30',
        payeeName: 'Service C',
        currentAmountMinor: '1250',
        currentCurrency: 'USD',
        previousAmountMinor: '1000',
        previousCurrency: 'USD',
      }, // +25%
    ];

    const result = buildSubscriptionPriceIncreases(rows);

    expect(result.items.map((i) => i.subscriptionId)).toEqual([
      'sub-20',
      'sub-30',
      'sub-10',
    ]);
    expect(result.items.map((i) => i.increasePercent)).toEqual([50, 25, 10]);
  });

  it('matches computeIncreasePercent from recurring domain exactly across vector cases', () => {
    const vectors = [
      {
        curr: '1250',
        prev: '1000',
        currCur: 'USD',
        prevCur: 'USD',
        expected: 25,
      },
      {
        curr: '1005',
        prev: '1000',
        currCur: 'USD',
        prevCur: 'USD',
        expected: 0.5,
      },
      {
        curr: '1000',
        prev: '1000',
        currCur: 'USD',
        prevCur: 'USD',
        expected: 0,
      },
      {
        curr: '900',
        prev: '1000',
        currCur: 'USD',
        prevCur: 'USD',
        expected: -10,
      },
      {
        curr: '1000',
        prev: '0',
        currCur: 'USD',
        prevCur: 'USD',
        expected: null,
      },
      {
        curr: '1000',
        prev: '1000',
        currCur: 'USD',
        prevCur: 'EUR',
        expected: null,
      },
    ];
    for (const v of vectors) {
      const canonical = computeIncreasePercent(
        { amountMinor: v.curr, currency: v.currCur },
        { amountMinor: v.prev, currency: v.prevCur },
      );
      expect(canonical).toBe(v.expected);
    }
  });
});

describe('buildRecurringVsVariable', () => {
  it('normalises and classifies frequencies Monthly, weekly, MONTHLY after trim and lowercase', () => {
    // 30 inclusive days: 2026-06-01 to 2026-06-30
    const from = '2026-06-01';
    const to = '2026-06-30';
    const subscriptions: readonly ConvertedSubscriptionRow[] = [
      { amountMinor: 10000n, frequency: 'Monthly' },
      { amountMinor: 5000n, frequency: ' weekly ' },
      { amountMinor: 20000n, frequency: 'MONTHLY' },
    ];
    const totalExpensesMinor = 100000n;

    const result = buildRecurringVsVariable(
      from,
      to,
      subscriptions,
      totalExpensesMinor,
    );

    expect(result.consideredSubscriptionCount).toBe(3);
    expect(result.unclassifiedSubscriptionCount).toBe(0);
    expect(result.committedMinor).toBeGreaterThan(0n);
    expect(result.committedMinor + result.variableMinor).toBe(
      totalExpensesMinor,
    );
  });

  it('marks unmatched frequencies every other Tuesday, empty, mensual as unclassified and counts them', () => {
    const from = '2026-01-01';
    const to = '2026-01-31';
    const subscriptions: readonly ConvertedSubscriptionRow[] = [
      { amountMinor: 10000n, frequency: 'every other Tuesday' },
      { amountMinor: 5000n, frequency: '' },
      { amountMinor: 8000n, frequency: 'mensual' },
      { amountMinor: 12000n, frequency: 'monthly' }, // 1 classified
    ];
    const totalExpensesMinor = 50000n;

    const result = buildRecurringVsVariable(
      from,
      to,
      subscriptions,
      totalExpensesMinor,
    );

    expect(result.consideredSubscriptionCount).toBe(4);
    expect(result.unclassifiedSubscriptionCount).toBe(3);
    // Only the 'monthly' subscription contributes to committedMinor:
    // roundDivHalfAwayFromZero(12000n * 12n * 31n, 365n) = roundDiv(4464000n, 365n)
    // 4464000 / 365 = 12230.13698... -> 12230n (remainder 50, 2*50=100 < 365)
    expect(result.committedMinor).toBe(12230n);
  });

  it('preserves committed + variable === totalExpenses as an exact identity when variable is negative', () => {
    const from = '2026-01-01';
    const to = '2026-01-31'; // 31 days
    // Monthly 10000n committed for 31 days = 10192n
    const subscriptions: readonly ConvertedSubscriptionRow[] = [
      { amountMinor: 10000n, frequency: 'monthly' },
    ];
    // Observed spend totalExpensesMinor is only 6000n (less than committed 10192n)
    const totalExpensesMinor = 6000n;

    const result = buildRecurringVsVariable(
      from,
      to,
      subscriptions,
      totalExpensesMinor,
    );

    expect(result.committedMinor).toBe(10192n);
    expect(result.variableMinor).toBe(-4192n);
    expect(result.totalExpensesMinor).toBe(6000n);
    // Identity must hold: committed + variable === totalExpenses
    expect(result.committedMinor + result.variableMinor).toBe(
      result.totalExpensesMinor,
    );
    // committedPercent = (10192 / 6000) * 100 = 169.8666... -> 169.87%
    expect(result.committedPercent).toBe(169.87);
  });

  it('returns committedPercent as null when totalExpensesMinor is 0n', () => {
    const from = '2026-01-01';
    const to = '2026-01-31';
    const subscriptions: readonly ConvertedSubscriptionRow[] = [
      { amountMinor: 10000n, frequency: 'monthly' },
    ];
    const totalExpensesMinor = 0n;

    const result = buildRecurringVsVariable(
      from,
      to,
      subscriptions,
      totalExpensesMinor,
    );

    expect(result.committedMinor).toBe(10192n);
    expect(result.variableMinor).toBe(-10192n);
    expect(result.committedMinor + result.variableMinor).toBe(0n);
    expect(result.committedPercent).toBeNull();
  });

  it('computes different committed amounts for 31-day vs 28-day periods for the same monthly subscription', () => {
    /**
     * Hand derivation:
     * amountMinor = 10000n, frequency = 'monthly' -> perYear = 12n
     * Formula: roundDivHalfAwayFromZero(amountMinor * perYear * days, 365n)
     *
     * 1) 31-day period (2026-01-01 to 2026-01-31, inclusive days = 31):
     *    num = 10000n * 12n * 31n = 3720000n
     *    3720000 / 365 = 10191 with remainder 285
     *    2 * 285 = 570 >= 365 -> rounds up to 10192n
     *
     * 2) 28-day period (2026-02-01 to 2026-02-28, inclusive days = 28):
     *    num = 10000n * 12n * 28n = 3360000n
     *    3360000 / 365 = 9205 with remainder 175
     *    2 * 175 = 350 < 365 -> rounds down to 9205n
     *
     * 10192n !== 9205n (difference = 987n)
     */
    const sub: readonly ConvertedSubscriptionRow[] = [
      { amountMinor: 10000n, frequency: 'monthly' },
    ];

    const result31 = buildRecurringVsVariable(
      '2026-01-01',
      '2026-01-31',
      sub,
      20000n,
    );
    const result28 = buildRecurringVsVariable(
      '2026-02-01',
      '2026-02-28',
      sub,
      20000n,
    );

    expect(result31.committedMinor).toBe(10192n);
    expect(result28.committedMinor).toBe(9205n);
    expect(result31.committedMinor).not.toBe(result28.committedMinor);
  });
});

describe('buildDebtCostEvolution', () => {
  it('presents zero-filled buckets for months with no payments and assigns payments correctly across UTC boundaries', () => {
    // 3 months: Jan, Feb, Mar 2026
    const from = '2026-01-01';
    const to = '2026-03-31';
    const rows: readonly ConvertedDebtCostRow[] = [
      // 2026-01-31T23:59:59.999Z -> UTC month is January
      {
        interestMinor: 1000n,
        feeMinor: 200n,
        occurredAt: new Date('2026-01-31T23:59:59.999Z'),
      },
      // 2026-02-01T00:00:00.000Z -> UTC month is February
      {
        interestMinor: 1500n,
        feeMinor: 300n,
        occurredAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      // March has NO payments -> must be present, gap-free, zero-filled
    ];

    const result = buildDebtCostEvolution(from, to, rows);

    expect(result.series).toHaveLength(3);
    // January bucket
    expect(result.series[0]).toEqual({
      month: '2026-01-01',
      interestMinor: 1000n,
      feeMinor: 200n,
      totalCostMinor: 1200n,
    });
    // February bucket
    expect(result.series[1]).toEqual({
      month: '2026-02-01',
      interestMinor: 1500n,
      feeMinor: 300n,
      totalCostMinor: 1800n,
    });
    // March bucket: zero-filled
    expect(result.series[2]).toEqual({
      month: '2026-03-01',
      interestMinor: 0n,
      feeMinor: 0n,
      totalCostMinor: 0n,
    });
  });

  it('ensures totalCostMinor === interestMinor + feeMinor in every bucket and period totals match', () => {
    const from = '2026-01-01';
    const to = '2026-02-28';
    const rows: readonly ConvertedDebtCostRow[] = [
      {
        interestMinor: 4000n,
        feeMinor: 800n,
        occurredAt: new Date('2026-01-15T12:00:00Z'),
      },
      {
        interestMinor: 2500n,
        feeMinor: 500n,
        occurredAt: new Date('2026-01-20T12:00:00Z'),
      },
      {
        interestMinor: 3000n,
        feeMinor: 600n,
        occurredAt: new Date('2026-02-10T12:00:00Z'),
      },
    ];

    const result = buildDebtCostEvolution(from, to, rows);

    expect(result.series).toHaveLength(2);
    for (const point of result.series) {
      expect(point.totalCostMinor).toBe(point.interestMinor + point.feeMinor);
    }

    expect(result.totalInterestMinor).toBe(9500n);
    expect(result.totalFeeMinor).toBe(1900n);
    expect(result.totalCostMinor).toBe(11400n);
    expect(result.totalCostMinor).toBe(
      result.totalInterestMinor + result.totalFeeMinor,
    );
  });

  it('returns zero-filled series and all zero totals when input rows are empty', () => {
    const from = '2026-04-01';
    const to = '2026-05-31';
    const rows: readonly ConvertedDebtCostRow[] = [];

    const result = buildDebtCostEvolution(from, to, rows);

    expect(result.series).toEqual([
      {
        month: '2026-04-01',
        interestMinor: 0n,
        feeMinor: 0n,
        totalCostMinor: 0n,
      },
      {
        month: '2026-05-01',
        interestMinor: 0n,
        feeMinor: 0n,
        totalCostMinor: 0n,
      },
    ]);
    expect(result.totalInterestMinor).toBe(0n);
    expect(result.totalFeeMinor).toBe(0n);
    expect(result.totalCostMinor).toBe(0n);
  });
});
