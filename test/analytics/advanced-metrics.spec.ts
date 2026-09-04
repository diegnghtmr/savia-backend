import { describe, expect, it } from 'vitest';
import type { ConvertedFlowRow } from '../../src/analytics/analytics.port.js';
import { buildMonthlySavingsCapacity } from '../../src/analytics/advanced-metrics.js';

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
