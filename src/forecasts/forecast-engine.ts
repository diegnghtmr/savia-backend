import { roundDivHalfAwayFromZero } from '../platform/percentage-change.js';
import {
  FORECAST_METHOD,
  type ForecastConfidence,
  type ForecastPoint,
} from './forecast.port.js';

export interface AppliedScenarioRunData {
  readonly id: string;
  readonly monthlySavingsCapacityMinor: string;
}

export interface ForecastEngineInput {
  readonly openingBalanceMinor: bigint;
  readonly baseCurrency: string;
  readonly horizonDays: number;
  readonly today: Date;
  readonly monthlySavingsCapacities: readonly bigint[];
  readonly monthsOfHistoryAvailable: number;
  readonly includeScenarios: boolean;
  readonly appliedScenarioRun?: AppliedScenarioRunData | null;
}

export interface ForecastEngineResult {
  readonly series: readonly ForecastPoint[];
  readonly confidence: ForecastConfidence;
  readonly assumptions: readonly string[];
  readonly method: string;
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError('Square root of negative BigInt');
  }
  if (value === 0n || value === 1n) {
    return value;
  }
  let x0 = 1n << ((BigInt(value.toString(2).length) + 1n) / 2n);
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

export function computePopulationStdDev(values: readonly bigint[]): bigint {
  const n = values.length;
  if (n <= 1) {
    return 0n;
  }
  let sum = 0n;
  for (const v of values) {
    sum += v;
  }
  const mean = roundDivHalfAwayFromZero(sum, BigInt(n));
  let sumSquaredDiff = 0n;
  for (const v of values) {
    const diff = v - mean;
    sumSquaredDiff += diff * diff;
  }
  const variance = roundDivHalfAwayFromZero(sumSquaredDiff, BigInt(n));
  if (variance <= 0n) {
    return 0n;
  }
  // Scale by 10^8 to compute sqrt with 4 decimal digits of precision before roundDiv
  const scaledVariance = variance * 100000000n;
  const scaledSqrt = bigintSqrt(scaledVariance);
  return roundDivHalfAwayFromZero(scaledSqrt, 10000n);
}

export function computeConfidence(monthsAvailable: number): ForecastConfidence {
  if (monthsAvailable >= 6) {
    return 'high';
  }
  if (monthsAvailable >= 3) {
    return 'medium';
  }
  return 'low';
}

export function computeForecast(
  input: ForecastEngineInput,
): ForecastEngineResult {
  const {
    openingBalanceMinor,
    baseCurrency,
    horizonDays,
    today,
    monthlySavingsCapacities,
    monthsOfHistoryAvailable,
    includeScenarios,
    appliedScenarioRun,
  } = input;

  const confidence = computeConfidence(monthsOfHistoryAvailable);
  const assumptions: string[] = [];

  let dailyDrift = 0n;
  let stdDev = 0n;

  if (includeScenarios && appliedScenarioRun) {
    assumptions.push(`Applied scenario run ${appliedScenarioRun.id}.`);
    const scenarioMonthlySavings = BigInt(
      appliedScenarioRun.monthlySavingsCapacityMinor,
    );
    dailyDrift = roundDivHalfAwayFromZero(scenarioMonthlySavings, 30n);
    stdDev = 0n;
    assumptions.push(
      'Projection extrapolates a flat mean monthly flow and is not an observation.',
    );
    if (monthsOfHistoryAvailable > 0) {
      assumptions.push(
        `${monthsOfHistoryAvailable} month(s) of history available.`,
      );
    }
  } else {
    if (includeScenarios && !appliedScenarioRun) {
      assumptions.push(
        'includeScenarios was requested but no completed scenario run existed; proceeded from history.',
      );
    }

    if (
      monthsOfHistoryAvailable === 0 ||
      monthlySavingsCapacities.length === 0
    ) {
      dailyDrift = 0n;
      stdDev = 0n;
      assumptions.push(
        '0 months of history available; daily drift and bounds are zero.',
      );
      assumptions.push(
        'Projection extrapolates a flat mean monthly flow and is not an observation.',
      );
    } else {
      const nMonths = BigInt(monthlySavingsCapacities.length);
      let totalSavings = 0n;
      for (const cap of monthlySavingsCapacities) {
        totalSavings += cap;
      }
      const meanMonthlySavings = roundDivHalfAwayFromZero(
        totalSavings,
        nMonths,
      );
      dailyDrift = roundDivHalfAwayFromZero(meanMonthlySavings, 30n);
      stdDev = computePopulationStdDev(monthlySavingsCapacities);
      assumptions.push(
        `${monthlySavingsCapacities.length} month(s) of history used.`,
      );
      assumptions.push(
        'Projection extrapolates a flat mean monthly flow and is not an observation.',
      );
    }
  }

  const series: ForecastPoint[] = [];
  const startYear = today.getUTCFullYear();
  const startMonth = today.getUTCMonth();
  const startDay = today.getUTCDate();

  for (let n = 1; n <= horizonDays; n++) {
    const pointDate = new Date(Date.UTC(startYear, startMonth, startDay + n));
    const dateStr = pointDate.toISOString().slice(0, 10);

    const expectedMinor = openingBalanceMinor + dailyDrift * BigInt(n);
    const bandMinor = roundDivHalfAwayFromZero(stdDev * BigInt(n), 30n);
    const lowerBoundMinor = expectedMinor - bandMinor;
    const upperBoundMinor = expectedMinor + bandMinor;

    series.push({
      date: dateStr,
      expected: {
        amountMinor: expectedMinor.toString(),
        currency: baseCurrency,
      },
      lowerBound: {
        amountMinor: lowerBoundMinor.toString(),
        currency: baseCurrency,
      },
      upperBound: {
        amountMinor: upperBoundMinor.toString(),
        currency: baseCurrency,
      },
    });
  }

  return {
    series,
    confidence,
    assumptions,
    method: FORECAST_METHOD,
  };
}
