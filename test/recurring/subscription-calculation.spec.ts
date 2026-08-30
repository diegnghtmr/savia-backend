import { describe, expect, it } from 'vitest';
import { computeIncreasePercent } from '../../src/recurring/subscription-calculation.js';

describe('computeIncreasePercent (RULING 59 & RULING 60)', () => {
  const usd = (amountMinor: string) => ({ amountMinor, currency: 'USD' });
  const eur = (amountMinor: string) => ({ amountMinor, currency: 'EUR' });

  describe('RULING 59 — increasePercent is COMPUTED, never stored', () => {
    it('returns null when previousAmount is absent/undefined', () => {
      expect(computeIncreasePercent(usd('1000'), undefined)).toBeNull();
    });

    it('returns null when previousAmount is null', () => {
      expect(computeIncreasePercent(usd('1000'), null)).toBeNull();
    });

    it('returns null when previousAmount.amountMinor is 0 (never Infinity, never NaN, never thrown)', () => {
      expect(computeIncreasePercent(usd('1000'), usd('0'))).toBeNull();
    });

    it('returns 0 on equality (not null)', () => {
      expect(computeIncreasePercent(usd('1000'), usd('1000'))).toBe(0);
    });

    it('computes standard increase percentage correctly', () => {
      // (1500 - 1000) / 1000 * 100 = 50%
      expect(computeIncreasePercent(usd('1500'), usd('1000'))).toBe(50);
    });

    it('computes standard decrease percentage correctly', () => {
      // (800 - 1000) / 1000 * 100 = -20%
      expect(computeIncreasePercent(usd('800'), usd('1000'))).toBe(-20);
    });

    it('rounds to 2 decimal places properly', () => {
      // (100 - 300) / 300 * 100 = -66.666666... -> -66.67%
      expect(computeIncreasePercent(usd('100'), usd('300'))).toBe(-66.67);

      // (200 - 300) / 300 * 100 = -33.333333... -> -33.33%
      expect(computeIncreasePercent(usd('200'), usd('300'))).toBe(-33.33);

      // (12345 - 10000) / 10000 * 100 = 23.45%
      expect(computeIncreasePercent(usd('12345'), usd('10000'))).toBe(23.45);
    });
  });

  describe('RULING 60 — currency mismatch makes increasePercent null', () => {
    it('returns null when currentAmount and previousAmount have different currencies', () => {
      expect(computeIncreasePercent(usd('1500'), eur('1000'))).toBeNull();
      expect(computeIncreasePercent(eur('1000'), usd('1000'))).toBeNull();
    });
  });
});
