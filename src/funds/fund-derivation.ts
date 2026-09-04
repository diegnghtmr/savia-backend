export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface CalculateRecommendedMonthlyContributionParams {
  readonly targetAmountMinor: string;
  readonly currentAmountMinor: string;
  readonly currency: string;
  readonly targetDate: string | null | undefined;
}

export function calculateRecommendedMonthlyContribution(
  params: CalculateRecommendedMonthlyContributionParams,
  nowUtc: Date = new Date(),
): Money | undefined {
  if (params.targetDate === null || params.targetDate === undefined) {
    return undefined;
  }

  const targetYear = parseInt(params.targetDate.slice(0, 4), 10);
  const targetMonth = parseInt(params.targetDate.slice(5, 7), 10);

  const nowYear = nowUtc.getUTCFullYear();
  const nowMonth = nowUtc.getUTCMonth() + 1;

  const monthDiff = (targetYear - nowYear) * 12 + (targetMonth - nowMonth);
  const monthsRemaining = monthDiff <= 0 ? 1n : BigInt(monthDiff);

  const target = BigInt(params.targetAmountMinor);
  const current = BigInt(params.currentAmountMinor);

  if (current >= target) {
    return {
      amountMinor: '0',
      currency: params.currency,
    };
  }

  const remaining = target - current;
  const recommendedMinor = (remaining + monthsRemaining - 1n) / monthsRemaining;

  return {
    amountMinor: recommendedMinor.toString(),
    currency: params.currency,
  };
}
