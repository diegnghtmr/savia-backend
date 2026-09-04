import { describe, expect, it } from 'vitest';
import type {
  ConvertedFlowRow,
  MonthlyCapacityPoint,
} from '../../src/analytics/analytics.port.js';
import {
  buildIncomeStability,
  buildMonthlySavingsCapacity,
  buildQuarterlyAverageComparison,
  buildWeekdayHeatmap,
} from '../../src/analytics/advanced-metrics.js';

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
