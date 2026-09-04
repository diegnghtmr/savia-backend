import { describe, expect, it } from 'vitest';
import type {
  ConvertedDebtCostRow,
  ConvertedFlowRow,
  ConvertedSubscriptionRow,
  MonthlyCapacityPoint,
  ScheduledOutflowRow,
  SubscriptionPriceRow,
} from '../../src/analytics/analytics.port.js';
import {
  bigintSqrt,
  buildBalanceProjection,
  buildDebtCostEvolution,
  buildFinancialCalendar,
  buildIncomeStability,
  buildMonthlySavingsCapacity,
  buildQuarterlyAverageComparison,
  buildRecurringVsVariable,
  buildSubscriptionPriceIncreases,
  buildWeekdayHeatmap,
} from '../../src/analytics/advanced-metrics.js';

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

  it('counts a row with malformed current amount in consideredCount but in no partition', () => {
    const rows: readonly SubscriptionPriceRow[] = [
      {
        id: 'sub-malformed',
        payeeName: 'Service Malformed',
        currentAmountMinor: 'abc',
        currentCurrency: 'USD',
        previousAmountMinor: '100',
        previousCurrency: 'USD',
      },
    ];

    const result = buildSubscriptionPriceIncreases(rows);

    expect(result.consideredCount).toBe(1);
    expect(result.decreasedOrUnchangedCount).toBe(0);
    expect(result.excludedForCurrencyMismatch).toBe(0);
    expect(result.excludedForZeroPrevious).toBe(0);
    expect(result.items).toHaveLength(0);
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

  it('returns null for committedPercent when computed percent is non-finite and ensures non-null values are always finite', () => {
    const from = '2024-01-01';
    const to = '2024-01-01';
    const subscriptions: readonly ConvertedSubscriptionRow[] = [
      { amountMinor: 10n ** 400n, frequency: 'daily' },
    ];
    const totalExpensesMinor = 1n;

    const result = buildRecurringVsVariable(
      from,
      to,
      subscriptions,
      totalExpensesMinor,
    );

    // Non-finite computed percentage returns null explicitly instead of Infinity
    expect(result.committedPercent).toBeNull();
    // Guard invariant: Number.isFinite is never false for any returned non-null committedPercent
    if (result.committedPercent !== null) {
      expect(Number.isFinite(result.committedPercent)).toBe(true);
    }
  });

  it('pins exact committedMinor for every token in the frequency table one subscription at a time', () => {
    // Fixed period: 2026-01-01 to 2026-01-31 (31 inclusive days)
    // Subscription amount: 10000n minor units
    // Formula: roundDivHalfAwayFromZero(amountMinor * perYear * days, 365n)
    //
    // Hand derivations (amountMinor = 10000n, days = 31n, amountMinor * days = 310000n):
    //
    // 1. daily: perYear = 365n
    //    num = 310000n * 365n = 113,150,000n
    //    113150000 / 365 = 310000 with remainder 0
    //    expected = 310000n
    //
    // 2. weekly: perYear = 52n
    //    num = 310000n * 52n = 16,120,000n
    //    16120000 / 365 = 44164 with remainder 140
    //    2 * 140 = 280 < 365 -> round down
    //    expected = 44164n
    //
    // 3. biweekly: perYear = 26n
    //    num = 310000n * 26n = 8,060,000n
    //    8060000 / 365 = 22082 with remainder 70
    //    2 * 70 = 140 < 365 -> round down
    //    expected = 22082n
    //
    // 4. fortnightly: perYear = 26n
    //    num = 310000n * 26n = 8,060,000n
    //    8060000 / 365 = 22082 with remainder 70
    //    2 * 70 = 140 < 365 -> round down
    //    expected = 22082n
    //
    // 5. monthly: perYear = 12n
    //    num = 310000n * 12n = 3,720,000n
    //    3720000 / 365 = 10191 with remainder 285
    //    2 * 285 = 570 >= 365 -> round up to 10192n
    //    expected = 10192n
    //
    // 6. bimonthly: perYear = 6n
    //    num = 310000n * 6n = 1,860,000n
    //    1860000 / 365 = 5095 with remainder 325
    //    2 * 325 = 650 >= 365 -> round up to 5096n
    //    expected = 5096n
    //
    // 7. quarterly: perYear = 4n
    //    num = 310000n * 4n = 1,240,000n
    //    1240000 / 365 = 3397 with remainder 95
    //    2 * 95 = 190 < 365 -> round down
    //    expected = 3397n
    //
    // 8. semiannual: perYear = 2n
    //    num = 310000n * 2n = 620,000n
    //    620000 / 365 = 1698 with remainder 230
    //    2 * 230 = 460 >= 365 -> round up to 1699n
    //    expected = 1699n
    //
    // 9. semiannually: perYear = 2n
    //    num = 310000n * 2n = 620,000n
    //    620000 / 365 = 1698 with remainder 230
    //    2 * 230 = 460 >= 365 -> round up to 1699n
    //    expected = 1699n
    //
    // 10. biannual: perYear = 2n
    //     num = 310000n * 2n = 620,000n
    //     620000 / 365 = 1698 with remainder 230
    //     2 * 230 = 460 >= 365 -> round up to 1699n
    //     expected = 1699n
    //
    // 11. yearly: perYear = 1n
    //     num = 310000n * 1n = 310,000n
    //     310000 / 365 = 849 with remainder 115
    //     2 * 115 = 230 < 365 -> round down
    //     expected = 849n
    //
    // 12. annual: perYear = 1n
    //     num = 310000n * 1n = 310,000n
    //     310000 / 365 = 849 with remainder 115
    //     2 * 115 = 230 < 365 -> round down
    //     expected = 849n
    //
    // 13. annually: perYear = 1n
    //     num = 310000n * 1n = 310,000n
    //     310000 / 365 = 849 with remainder 115
    //     2 * 115 = 230 < 365 -> round down
    //     expected = 849n
    const from = '2026-01-01';
    const to = '2026-01-31';
    const amountMinor = 10000n;
    const totalExpensesMinor = 500000n;

    const testCases: readonly {
      readonly frequency: string;
      readonly expectedCommittedMinor: bigint;
    }[] = [
      { frequency: 'daily', expectedCommittedMinor: 310000n },
      { frequency: 'weekly', expectedCommittedMinor: 44164n },
      { frequency: 'biweekly', expectedCommittedMinor: 22082n },
      { frequency: 'fortnightly', expectedCommittedMinor: 22082n },
      { frequency: 'monthly', expectedCommittedMinor: 10192n },
      { frequency: 'bimonthly', expectedCommittedMinor: 5096n },
      { frequency: 'quarterly', expectedCommittedMinor: 3397n },
      { frequency: 'semiannual', expectedCommittedMinor: 1699n },
      { frequency: 'semiannually', expectedCommittedMinor: 1699n },
      { frequency: 'biannual', expectedCommittedMinor: 1699n },
      { frequency: 'yearly', expectedCommittedMinor: 849n },
      { frequency: 'annual', expectedCommittedMinor: 849n },
      { frequency: 'annually', expectedCommittedMinor: 849n },
    ];

    for (const testCase of testCases) {
      const result = buildRecurringVsVariable(
        from,
        to,
        [{ amountMinor, frequency: testCase.frequency }],
        totalExpensesMinor,
      );

      expect(
        result.committedMinor,
        `committedMinor mismatch for frequency: ${testCase.frequency}`,
      ).toBe(testCase.expectedCommittedMinor);
      expect(result.consideredSubscriptionCount).toBe(1);
      expect(result.unclassifiedSubscriptionCount).toBe(0);
    }
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

describe('buildFinancialCalendar', () => {
  it('returns exactly three days for a 365-day period with pre-shuffled days and item-level tie-breaks', () => {
    const from = '2026-01-01';
    const to = '2026-12-31';
    // Pre-shuffled order: October, February, May (with tied items in reverse order of kind and refId)
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'recurring_rule',
        refId: 'rule-1',
        label: 'Internet',
        amountMinor: 4000n,
        scheduledDate: '2026-10-10',
        template: {
          type: 'expense',
          amount: { amountMinor: '4000', currency: 'USD' },
        },
      },
      {
        kind: 'subscription',
        refId: 'sub-1',
        label: 'Streaming',
        amountMinor: 1000n,
        scheduledDate: '2026-02-15',
      },
      {
        kind: 'subscription',
        refId: 'sub-2',
        label: 'Cloud Backup',
        amountMinor: 1500n,
        scheduledDate: '2026-05-20',
      },
      {
        kind: 'subscription',
        refId: 'sub-1',
        label: 'Music',
        amountMinor: 1200n,
        scheduledDate: '2026-05-20',
      },
      {
        kind: 'debt_payment',
        refId: 'debt-1',
        label: 'Car Loan',
        amountMinor: 2500n,
        scheduledDate: '2026-05-20',
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    // M1 test: must return exactly 3 days, not 365
    expect(result.days).toHaveLength(3);
    // Ascending chronological order: February, May, October
    expect(result.days.map((d) => d.date)).toEqual([
      '2026-02-15',
      '2026-05-20',
      '2026-10-10',
    ]);
    expect(result.periodStart).toBe(from);
    expect(result.periodEnd).toBe(to);

    // Tied date 2026-05-20: secondary sort by kind (debt_payment < subscription), tertiary sort by refId (sub-1 < sub-2)
    expect(
      result.days[1].items.map((i) => ({ kind: i.kind, refId: i.refId })),
    ).toEqual([
      { kind: 'debt_payment', refId: 'debt-1' },
      { kind: 'subscription', refId: 'sub-1' },
      { kind: 'subscription', refId: 'sub-2' },
    ]);
  });

  it('asserts directly that totalExpectedOutflowMinor equals the sum of every day', () => {
    const from = '2026-01-01';
    const to = '2026-03-31';
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'subscription',
        refId: 'sub-1',
        label: 'Music',
        amountMinor: 1500n,
        scheduledDate: '2026-01-10',
      },
      {
        kind: 'subscription',
        refId: 'sub-2',
        label: 'Cloud Storage',
        amountMinor: 3000n,
        scheduledDate: '2026-01-10',
      },
      {
        kind: 'debt_payment',
        refId: 'debt-1',
        label: 'Mortgage',
        amountMinor: 50000n,
        scheduledDate: '2026-02-01',
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-1',
        label: 'Insurance',
        amountMinor: 12000n,
        scheduledDate: '2026-03-15',
        template: {
          type: 'expense',
          amount: { amountMinor: '12000', currency: 'USD' },
        },
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    const sumFromDays = result.days.reduce(
      (sum, day) => sum + day.expectedOutflowMinor,
      0n,
    );
    expect(result.totalExpectedOutflowMinor).toBe(sumFromDays);
    expect(result.totalExpectedOutflowMinor).toBe(66500n);
    expect(result.days[0].expectedOutflowMinor).toBe(4500n);
    expect(result.days[1].expectedOutflowMinor).toBe(50000n);
    expect(result.days[2].expectedOutflowMinor).toBe(12000n);
  });

  it('collapses two items on the same date into one day with items ordered by kind then refId', () => {
    const from = '2026-03-01';
    const to = '2026-03-31';
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'recurring_rule',
        refId: 'rule-b',
        label: 'Gym Membership',
        amountMinor: 3000n,
        scheduledDate: '2026-03-15',
        template: {
          type: 'expense',
          amount: { amountMinor: '3000', currency: 'USD' },
        },
      },
      {
        kind: 'debt_payment',
        refId: 'debt-a',
        label: 'Personal Loan',
        amountMinor: 2000n,
        scheduledDate: '2026-03-15',
      },
      {
        kind: 'subscription',
        refId: 'sub-z',
        label: 'Software License',
        amountMinor: 1500n,
        scheduledDate: '2026-03-15',
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-a',
        label: 'Phone Bill',
        amountMinor: 1000n,
        scheduledDate: '2026-03-15',
        template: {
          type: 'expense',
          amount: { amountMinor: '1000', currency: 'USD' },
        },
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    expect(result.days).toHaveLength(1);
    expect(result.days[0].date).toBe('2026-03-15');
    expect(result.days[0].expectedOutflowMinor).toBe(7500n);
    // Ordered by kind ('debt_payment' < 'recurring_rule' < 'subscription'), then refId ('rule-a' < 'rule-b')
    expect(result.days[0].items).toEqual([
      {
        kind: 'debt_payment',
        refId: 'debt-a',
        label: 'Personal Loan',
        amountMinor: 2000n,
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-a',
        label: 'Phone Bill',
        amountMinor: 1000n,
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-b',
        label: 'Gym Membership',
        amountMinor: 3000n,
      },
      {
        kind: 'subscription',
        refId: 'sub-z',
        label: 'Software License',
        amountMinor: 1500n,
      },
    ]);
  });

  it('excludes recurring templates with unreadable amounts and counts them in recurringRulesWithUnreadableTemplate', () => {
    const from = '2026-04-01';
    const to = '2026-04-30';
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'recurring_rule',
        refId: 'rule-unreadable-string',
        label: 'Corrupted Amount',
        amountMinor: 'abc',
        scheduledDate: '2026-04-05',
        template: {
          type: 'expense',
          amount: { amountMinor: 'abc', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-missing-amount-obj',
        label: 'Missing Amount Object',
        scheduledDate: '2026-04-10',
        template: {
          type: 'expense',
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-valid',
        label: 'Valid Recurring Expense',
        amountMinor: 5000n,
        scheduledDate: '2026-04-15',
        template: {
          type: 'expense',
          amount: { amountMinor: '5000', currency: 'USD' },
        },
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    // M3 test: unreadable amounts are excluded and counted, never treated as 0n in calendar
    expect(result.recurringRulesWithUnreadableTemplate).toBe(2);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].date).toBe('2026-04-15');
    expect(result.days[0].items).toHaveLength(1);
    expect(result.days[0].items[0].refId).toBe('rule-valid');
    expect(result.totalExpectedOutflowMinor).toBe(5000n);
  });

  it('excludes income-typed recurring templates entirely and retains only outflow types', () => {
    const from = '2026-05-01';
    const to = '2026-05-31';
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'recurring_rule',
        refId: 'rule-income',
        label: 'Salary Automation',
        amountMinor: 100000n,
        scheduledDate: '2026-05-01',
        template: {
          type: 'income',
          amount: { amountMinor: '100000', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-refund',
        label: 'Scheduled Refund',
        amountMinor: 2000n,
        scheduledDate: '2026-05-05',
        template: {
          type: 'refund',
          amount: { amountMinor: '2000', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-transfer',
        label: 'Scheduled Transfer',
        amountMinor: 5000n,
        scheduledDate: '2026-05-10',
        template: {
          type: 'transfer',
          amount: { amountMinor: '5000', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-adjustment',
        label: 'Scheduled Adjustment',
        amountMinor: 3000n,
        scheduledDate: '2026-05-12',
        template: {
          type: 'adjustment',
          amount: { amountMinor: '3000', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-expense',
        label: 'Office Supplies',
        amountMinor: 1500n,
        scheduledDate: '2026-05-15',
        template: {
          type: 'expense',
          amount: { amountMinor: '1500', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-debt-pmt',
        label: 'Recurring Debt Payment',
        amountMinor: 2500n,
        scheduledDate: '2026-05-20',
        template: {
          type: 'debt_payment',
          amount: { amountMinor: '2500', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-fund-contrib',
        label: 'Emergency Fund Contribution',
        amountMinor: 3500n,
        scheduledDate: '2026-05-25',
        template: {
          type: 'fund_contribution',
          amount: { amountMinor: '3500', currency: 'USD' },
        },
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    // M2 test: income-typed recurring templates excluded entirely
    expect(result.days).toHaveLength(3);
    expect(
      result.days.some((d) => d.items.some((i) => i.refId === 'rule-income')),
    ).toBe(false);
    expect(
      result.days.some((d) => d.items.some((i) => i.refId === 'rule-refund')),
    ).toBe(false);
    expect(
      result.days.some((d) => d.items.some((i) => i.refId === 'rule-transfer')),
    ).toBe(false);
    expect(
      result.days.some((d) =>
        d.items.some((i) => i.refId === 'rule-adjustment'),
      ),
    ).toBe(false);
    expect(result.totalExpectedOutflowMinor).toBe(7500n); // 1500 + 2500 + 3500
  });

  it('requires an explicitly allowed outflow type for recurring templates and counts missing or non-outflow types as unreadable', () => {
    const from = '2026-04-01';
    const to = '2026-04-30';
    const rows: readonly ScheduledOutflowRow[] = [
      // Template with no type at all
      {
        kind: 'recurring_rule',
        refId: 'rule-no-type',
        label: 'Missing Type Rule',
        scheduledDate: '2026-04-05',
        template: {
          amount: { amountMinor: '777', currency: 'USD' },
        },
      },
      // Template with type: null
      {
        kind: 'recurring_rule',
        refId: 'rule-null-type',
        label: 'Null Type Rule',
        scheduledDate: '2026-04-10',
        template: {
          type: null,
          amount: { amountMinor: '888', currency: 'USD' },
        },
      },
      // Template with type: 'income'
      {
        kind: 'recurring_rule',
        refId: 'rule-income-type',
        label: 'Income Type Rule',
        scheduledDate: '2026-04-12',
        template: {
          type: 'income',
          amount: { amountMinor: '999', currency: 'USD' },
        },
      },
      // Allowed outflow types: expense, debt_payment, fund_contribution
      {
        kind: 'recurring_rule',
        refId: 'rule-expense-type',
        label: 'Expense Type Rule',
        scheduledDate: '2026-04-15',
        template: {
          type: 'expense',
          amount: { amountMinor: '1000', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-debt-pmt-type',
        label: 'Debt Payment Type Rule',
        scheduledDate: '2026-04-20',
        template: {
          type: 'debt_payment',
          amount: { amountMinor: '2000', currency: 'USD' },
        },
      },
      {
        kind: 'recurring_rule',
        refId: 'rule-fund-contrib-type',
        label: 'Fund Contribution Type Rule',
        scheduledDate: '2026-04-25',
        template: {
          type: 'fund_contribution',
          amount: { amountMinor: '3000', currency: 'USD' },
        },
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    // 3 invalid/unreadable templates (no type, null type, income) counted
    expect(result.recurringRulesWithUnreadableTemplate).toBe(3);
    // Only the 3 allowed outflow types emitted
    expect(result.days).toHaveLength(3);
    expect(result.totalExpectedOutflowMinor).toBe(6000n); // 1000 + 2000 + 3000
    const emittedRefIds = result.days.flatMap((d) =>
      d.items.map((i) => i.refId),
    );
    expect(emittedRefIds).toEqual([
      'rule-expense-type',
      'rule-debt-pmt-type',
      'rule-fund-contrib-type',
    ]);
  });

  it('counts an active debt with null minimum_payment_minor in debtsWithoutScheduledAmount and produces no calendar item', () => {
    const from = '2026-06-01';
    const to = '2026-06-30';
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'debt_payment',
        refId: 'debt-no-min',
        label: 'Informal Family Debt',
        amountMinor: null,
        scheduledDate: '2026-06-15',
      },
    ];

    const result = buildFinancialCalendar(from, to, rows, 2);

    expect(result.debtsWithoutScheduledAmount).toBe(3); // 2 passed in + 1 from rows
    expect(result.days).toHaveLength(0);
    expect(result.totalExpectedOutflowMinor).toBe(0n);
  });

  it('correctly assigns items to UTC dates across midnight boundaries', () => {
    const from = '2026-03-31';
    const to = '2026-04-01';
    const rows: readonly ScheduledOutflowRow[] = [
      {
        kind: 'subscription',
        refId: 'utc-item-1',
        label: 'End of March Sub',
        amountMinor: 2000n,
        scheduledDate: '2026-03-31T23:59:59.999Z',
      },
      {
        kind: 'subscription',
        refId: 'utc-item-2',
        label: 'Start of April Sub',
        amountMinor: 3000n,
        scheduledDate: '2026-04-01T00:00:00.000Z',
      },
    ];

    const result = buildFinancialCalendar(from, to, rows);

    expect(result.days).toHaveLength(2);
    expect(result.days[0].date).toBe('2026-03-31');
    expect(result.days[0].items[0].refId).toBe('utc-item-1');
    expect(result.days[1].date).toBe('2026-04-01');
    expect(result.days[1].items[0].refId).toBe('utc-item-2');
  });
});

describe('buildBalanceProjection', () => {
  it('returns zero means, a flat projection, and no division by zero when basisMonths === 0', () => {
    const from = '2026-07-01';
    const to = '2026-09-30';
    const openingBalanceMinor = 100000n;
    const history: readonly MonthlyCapacityPoint[] = [];

    const result = buildBalanceProjection(
      from,
      to,
      openingBalanceMinor,
      history,
    );

    expect(result.basisMonths).toBe(0);
    expect(result.meanMonthlyIncomeMinor).toBe(0n);
    expect(result.meanMonthlyExpensesMinor).toBe(0n);
    expect(result.openingBalanceMinor).toBe(100000n);
    expect(result.months).toHaveLength(3);
    expect(result.months).toEqual([
      {
        month: '2026-07-01',
        expectedInflowMinor: 0n,
        expectedOutflowMinor: 0n,
        projectedBalanceMinor: 100000n,
      },
      {
        month: '2026-08-01',
        expectedInflowMinor: 0n,
        expectedOutflowMinor: 0n,
        projectedBalanceMinor: 100000n,
      },
      {
        month: '2026-09-01',
        expectedInflowMinor: 0n,
        expectedOutflowMinor: 0n,
        projectedBalanceMinor: 100000n,
      },
    ]);
  });

  it('computes integer mean using history.length as divisor', () => {
    const from = '2026-01-01';
    const to = '2026-02-28';
    const openingBalanceMinor = 50000n;
    const history: readonly MonthlyCapacityPoint[] = [
      {
        month: '2025-11-01',
        incomeMinor: 60000n,
        expensesMinor: 40000n,
        savingsCapacityMinor: 20000n,
      },
      {
        month: '2025-12-01',
        incomeMinor: 80000n,
        expensesMinor: 50000n,
        savingsCapacityMinor: 30000n,
      },
    ];

    const result = buildBalanceProjection(
      from,
      to,
      openingBalanceMinor,
      history,
    );

    // M4 test: divisor must be history.length (2), not history.length + 1 (3)
    expect(result.basisMonths).toBe(2);
    // (60000 + 80000) / 2 = 70000n
    expect(result.meanMonthlyIncomeMinor).toBe(70000n);
    // (40000 + 50000) / 2 = 45000n
    expect(result.meanMonthlyExpensesMinor).toBe(45000n);
    expect(result.months[0].expectedInflowMinor).toBe(70000n);
    expect(result.months[0].expectedOutflowMinor).toBe(45000n);
    expect(result.months[0].projectedBalanceMinor).toBe(75000n); // 50000 + 25000
    expect(result.months[1].projectedBalanceMinor).toBe(100000n); // 75000 + 25000
  });

  it('drives projectedBalanceMinor negative when mean expenses exceed mean income and never clamps to zero', () => {
    const from = '2026-10-01';
    const to = '2026-12-31';
    const openingBalanceMinor = 10000n;
    const history: readonly MonthlyCapacityPoint[] = [
      {
        month: '2026-09-01',
        incomeMinor: 20000n,
        expensesMinor: 50000n,
        savingsCapacityMinor: -30000n,
      },
    ];

    const result = buildBalanceProjection(
      from,
      to,
      openingBalanceMinor,
      history,
    );

    // M5 test: nothing is clamped at 0n; projection goes negative and stays negative
    expect(result.months).toHaveLength(3);
    expect(result.months[0].projectedBalanceMinor).toBe(-20000n); // 10000 - 30000
    expect(result.months[1].projectedBalanceMinor).toBe(-50000n); // -20000 - 30000
    expect(result.months[2].projectedBalanceMinor).toBe(-80000n); // -50000 - 30000
    expect(result.months.every((m) => m.projectedBalanceMinor < 0n)).toBe(true);
  });

  it('applies half-away-from-zero rounding on the means including a negative case', () => {
    const from = '2026-01-01';
    const to = '2026-01-31';
    const openingBalanceMinor = 0n;

    // Positive tie: (10000 + 10001) / 2 = 20001 / 2 = 10000.5 -> 10001
    // Negative tie: (-10000 + -10001) / 2 = -20001 / 2 = -10000.5 -> -10001 (away from zero)
    const history: readonly MonthlyCapacityPoint[] = [
      {
        month: '2025-10-01',
        incomeMinor: 10000n,
        expensesMinor: -10000n,
        savingsCapacityMinor: 20000n,
      },
      {
        month: '2025-11-01',
        incomeMinor: 10001n,
        expensesMinor: -10001n,
        savingsCapacityMinor: 20002n,
      },
    ];

    const result = buildBalanceProjection(
      from,
      to,
      openingBalanceMinor,
      history,
    );

    expect(result.meanMonthlyIncomeMinor).toBe(10001n);
    expect(result.meanMonthlyExpensesMinor).toBe(-10001n);
    expect(result.months[0].expectedInflowMinor).toBe(10001n);
    expect(result.months[0].expectedOutflowMinor).toBe(-10001n);
    // Net: 10001 - (-10001) = 20002n
    expect(result.months[0].projectedBalanceMinor).toBe(20002n);
  });
});
