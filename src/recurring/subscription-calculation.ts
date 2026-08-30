export interface AmountMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

/**
 * Computes increasePercent between currentAmount and previousAmount.
 *
 * RULING 59: increasePercent is COMPUTED, never stored.
 * - If previousAmount is absent/null -> null.
 * - If previousAmount.amountMinor is '0' -> null. Never Infinity, never NaN, never a thrown error.
 * - Otherwise: ((current - previous) / previous) * 100.
 * - Rounding: Rounded to 2 decimal places using Math.round(percent * 100) / 100.
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

  const previous = Number(previousAmount.amountMinor);
  // RULING 59: previousAmount.amountMinor is 0 -> increasePercent is null. Never Infinity, never NaN, never a thrown error.
  if (previous === 0 || Number.isNaN(previous)) {
    return null;
  }

  const current = Number(currentAmount.amountMinor);
  if (Number.isNaN(current)) {
    return null;
  }

  // RULING 59: equality must be 0, not null
  if (current === previous) {
    return 0;
  }

  const percent = ((current - previous) / previous) * 100;
  const rounded = Math.round(percent * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
