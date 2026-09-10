import { describe, expect, it } from 'vitest';
import { calculateRecommendedMonthlyContribution } from '../../src/funds/fund-derivation.js';

describe('calculateRecommendedMonthlyContribution', () => {
  it('omits recommendedMonthlyContribution when targetDate is null or undefined', () => {
    expect(
      calculateRecommendedMonthlyContribution({
        targetAmountMinor: '100000',
        currentAmountMinor: '0',
        currency: 'USD',
        targetDate: null,
      }),
    ).toBeUndefined();

    expect(
      calculateRecommendedMonthlyContribution({
        targetAmountMinor: '100000',
        currentAmountMinor: '0',
        currency: 'USD',
        targetDate: undefined,
      }),
    ).toBeUndefined();
  });

  it('clamps recommendedMonthlyContribution to 0 when currentAmount >= targetAmount', () => {
    const now = new Date('2026-09-03T12:00:00Z');
    const resultEqual = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100000',
        currentAmountMinor: '100000',
        currency: 'USD',
        targetDate: '2026-12-31',
      },
      now,
    );
    expect(resultEqual).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });

    const resultGreater = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100000',
        currentAmountMinor: '150000',
        currency: 'USD',
        targetDate: '2026-12-31',
      },
      now,
    );
    expect(resultGreater).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });
  });

  it('sets monthsRemaining to 1 when targetDate is in the past or current month', () => {
    const now = new Date('2026-09-03T12:00:00Z');

    // Target date in current month (September 2026)
    const currentMonth = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100000',
        currentAmountMinor: '30000',
        currency: 'USD',
        targetDate: '2026-09-25',
      },
      now,
    );
    expect(currentMonth).toEqual({
      amountMinor: '70000',
      currency: 'USD',
    });

    // Target date in past month (August 2026)
    const pastMonth = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100000',
        currentAmountMinor: '40000',
        currency: 'USD',
        targetDate: '2026-08-15',
      },
      now,
    );
    expect(pastMonth).toEqual({
      amountMinor: '60000',
      currency: 'USD',
    });
  });

  it('computes ceiling division (ceil((target - current) / monthsRemaining)) in UTC', () => {
    const now = new Date('2026-09-03T12:00:00Z');
    // November 2026 -> 2 months remaining (September to November = (2026-2026)*12 + (11 - 9) = 2)
    // Target: 100, Current: 0. 100 / 2 = 50
    const exact = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100',
        currentAmountMinor: '0',
        currency: 'USD',
        targetDate: '2026-11-01',
      },
      now,
    );
    expect(exact).toEqual({
      amountMinor: '50',
      currency: 'USD',
    });

    // Target: 100, Current: 1 -> remaining 99. 99 / 2 = 49.5 -> ceil is 50.
    const ceilUp = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100',
        currentAmountMinor: '1',
        currency: 'USD',
        targetDate: '2026-11-01',
      },
      now,
    );
    expect(ceilUp).toEqual({
      amountMinor: '50',
      currency: 'USD',
    });

    // 3 months remaining (December 2026 -> (12 - 9) = 3)
    // remaining: 100 -> ceil(100 / 3) = 34
    const threeMonths = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: '100',
        currentAmountMinor: '0',
        currency: 'USD',
        targetDate: '2026-12-15',
      },
      now,
    );
    expect(threeMonths).toEqual({
      amountMinor: '34',
      currency: 'USD',
    });
  });

  it('uses exact BigInt arithmetic with no floating-point precision loss', () => {
    const now = new Date('2026-09-03T12:00:00Z');
    // Large 64-bit int amount
    const target = '9000000000000000001';
    const current = '0';
    // October 2026 -> 1 month remaining
    const result = calculateRecommendedMonthlyContribution(
      {
        targetAmountMinor: target,
        currentAmountMinor: current,
        currency: 'USD',
        targetDate: '2026-10-01',
      },
      now,
    );
    expect(result).toEqual({
      amountMinor: '9000000000000000001',
      currency: 'USD',
    });
  });
});
