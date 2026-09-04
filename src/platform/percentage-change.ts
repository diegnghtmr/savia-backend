export interface AmountMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Integer division with half-away-from-zero (symmetric half-up) rounding.
 * Reuses the same tie-breaking logic as computeIncreasePercent:
 * exact half ties (e.g. ±0.5) round away from zero to the larger magnitude.
 */
export function roundDivHalfAwayFromZero(num: bigint, den: bigint): bigint {
  if (den === 0n) {
    throw new Error('Division by zero in roundDivHalfAwayFromZero');
  }
  const n = den < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n % d;
  if (n >= 0n) {
    return 2n * r >= d ? q + 1n : q;
  }
  const absR = -r;
  return 2n * absR >= d ? q - 1n : q;
}

/**
 * Computes increasePercent between currentAmount and previousAmount.
 *
 * RULING 59: increasePercent is COMPUTED, never stored.
 * - If previousAmount is absent/null -> null.
 * - If previousAmount.amountMinor is '0' -> null. Never Infinity, never NaN, never a thrown error.
 * - Otherwise: ((current - previous) / previous) * 100.
 * - Rounding: Rounded to 2 decimal places using BigInt scaled integer arithmetic.
 *   Tie-breaking rule: Round half-away-from-zero (symmetric half-up), where exact half ties
 *   (e.g. ±0.005%) round away from zero to the larger magnitude.
 * - Equality (current === previous) must be 0, not null.
 *
 * RULING 60: currency mismatch makes increasePercent null.
 * - If currentAmount.currency !== previousAmount.currency -> null.
 */
export function computeIncreasePercent(
  currentAmount: AmountMoney,
  previousAmount?: AmountMoney | null,
): number | null {
  // RULING 59: previousAmount absent -> increasePercent is null
  if (!previousAmount) {
    return null;
  }

  // RULING 60: a currency mismatch makes increasePercent null
  if (currentAmount.currency !== previousAmount.currency) {
    return null;
  }

  if (
    !INTEGER_PATTERN.test(previousAmount.amountMinor) ||
    !INTEGER_PATTERN.test(currentAmount.amountMinor)
  ) {
    return null;
  }

  const previous = BigInt(previousAmount.amountMinor);
  // RULING 59: previousAmount.amountMinor is 0 -> increasePercent is null. Never Infinity, never NaN, never a thrown error.
  if (previous === 0n) {
    return null;
  }

  const current = BigInt(currentAmount.amountMinor);

  // RULING 59: equality must be 0, not null
  if (current === previous) {
    return 0;
  }

  // Scale delta by 10,000 to compute percentage in hundredths of a percent (0.01%).
  // Tie-breaking rule: Round half-away-from-zero (symmetric half-up), where exact half ties
  // (e.g. ±0.005%) round away from zero to the larger magnitude.
  const roundedHundredths = roundDivHalfAwayFromZero(
    (current - previous) * 10000n,
    previous,
  );

  const result = Number(roundedHundredths) / 100;
  return Object.is(result, -0) ? 0 : result;
}
