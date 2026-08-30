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

    describe('Precision preservation above 2^53 - 1 (TYPE B regression)', () => {
      it('preserves precision for BIGINT values where Number conversion loses rounding accuracy', () => {
        // previous: 9007199254760001, current: 9007649614722739
        // exact delta: 450359962738, delta * 20000 = 9007199254760000 < previous (9007199254760001)
        // exact percentage is strictly below 0.005%, so it must round to 0.00.
        // Number conversion rounds both operands and wrongly yields 0.01.
        const result = computeIncreasePercent(
          usd('9007649614722739'),
          usd('9007199254760001'),
        );
        expect(result).toBe(0);
        expect(Object.is(result, -0)).toBe(false);
      });
    });

    describe('Exact .005 rounding boundary (half-away-from-zero tie rule)', () => {
      it('rounds exact positive and negative half ties away from zero', () => {
        // Exact +0.005% tie: ((20001 - 20000) / 20000) * 100 = 0.005% -> +0.01%
        const posHalf = computeIncreasePercent(usd('20001'), usd('20000'));
        expect(posHalf).toBe(0.01);
        expect(Object.is(posHalf, -0)).toBe(false);

        // Strictly below +0.005% (+0.0025%): ((40001 - 40000) / 40000) * 100 = 0.0025% -> 0%
        const posBelow = computeIncreasePercent(usd('40001'), usd('40000'));
        expect(posBelow).toBe(0);
        expect(Object.is(posBelow, -0)).toBe(false);

        // Exact -0.005% tie: ((19999 - 20000) / 20000) * 100 = -0.005% -> -0.01%
        const negHalf = computeIncreasePercent(usd('19999'), usd('20000'));
        expect(negHalf).toBe(-0.01);
        expect(Object.is(negHalf, -0)).toBe(false);

        // Strictly below -0.005% (-0.0025%): ((39999 - 40000) / 40000) * 100 = -0.0025% -> 0%
        const negBelow = computeIncreasePercent(usd('39999'), usd('40000'));
        expect(negBelow).toBe(0);
        expect(Object.is(negBelow, -0)).toBe(false);

        // Exact +1.005% tie: ((20201 - 20000) / 20000) * 100 = 1.005% -> +1.01%
        const pos1005 = computeIncreasePercent(usd('20201'), usd('20000'));
        expect(pos1005).toBe(1.01);
        expect(Object.is(pos1005, -0)).toBe(false);

        // Exact -1.005% tie: ((19799 - 20000) / 20000) * 100 = -1.005% -> -1.01%
        const neg1005 = computeIncreasePercent(usd('19799'), usd('20000'));
        expect(neg1005).toBe(-1.01);
        expect(Object.is(neg1005, -0)).toBe(false);
      });
    });

    describe('Negative previous / negative current combinations (literal formula)', () => {
      it('evaluates signed amounts according to the literal formula ((current - previous) / previous) * 100', () => {
        // previous -1000, current -500: delta = +500, (+500 / -1000) * 100 = -50%
        const debtReduced = computeIncreasePercent(usd('-500'), usd('-1000'));
        expect(debtReduced).toBe(-50);
        expect(Object.is(debtReduced, -0)).toBe(false);

        // previous -1000, current -1500: delta = -500, (-500 / -1000) * 100 = +50%
        const debtIncreased = computeIncreasePercent(
          usd('-1500'),
          usd('-1000'),
        );
        expect(debtIncreased).toBe(50);
        expect(Object.is(debtIncreased, -0)).toBe(false);

        // previous -1000, current +500: delta = +1500, (+1500 / -1000) * 100 = -150%
        const debtToAsset = computeIncreasePercent(usd('500'), usd('-1000'));
        expect(debtToAsset).toBe(-150);
        expect(Object.is(debtToAsset, -0)).toBe(false);

        // previous +1000, current -1000: delta = -2000, (-2000 / 1000) * 100 = -200%
        const assetToDebt = computeIncreasePercent(usd('-1000'), usd('1000'));
        expect(assetToDebt).toBe(-200);
        expect(Object.is(assetToDebt, -0)).toBe(false);
      });
    });

    describe('Corrupt and non-numeric input handling', () => {
      it('returns null for non-numeric or malformed amountMinor strings (never NaN or Infinity)', () => {
        expect(computeIncreasePercent(usd('abc'), usd('1000'))).toBeNull();
        expect(computeIncreasePercent(usd('1000'), usd('abc'))).toBeNull();
        expect(computeIncreasePercent(usd('Infinity'), usd('1000'))).toBeNull();
        expect(computeIncreasePercent(usd('1000'), usd('Infinity'))).toBeNull();
        expect(
          computeIncreasePercent(usd('-Infinity'), usd('1000')),
        ).toBeNull();
        expect(
          computeIncreasePercent(usd('1000'), usd('-Infinity')),
        ).toBeNull();
        expect(computeIncreasePercent(usd('1.5'), usd('1000'))).toBeNull();
        expect(computeIncreasePercent(usd('1000'), usd('1.5'))).toBeNull();
        expect(computeIncreasePercent(usd(''), usd('1000'))).toBeNull();
        expect(computeIncreasePercent(usd('1000'), usd(''))).toBeNull();
      });
    });
  });

  describe('RULING 60 — currency mismatch makes increasePercent null', () => {
    it('returns null when currentAmount and previousAmount have different currencies', () => {
      expect(computeIncreasePercent(usd('1500'), eur('1000'))).toBeNull();
      expect(computeIncreasePercent(eur('1000'), usd('1000'))).toBeNull();
    });
  });
});
