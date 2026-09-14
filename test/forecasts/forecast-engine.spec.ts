import { describe, expect, it } from 'vitest';
import {
  computeForecast,
  type ForecastEngineInput,
} from '../../src/forecasts/forecast-engine.js';
import { FORECAST_METHOD } from '../../src/forecasts/forecast.port.js';

describe('forecast-engine', () => {
  const baseCurrency = 'USD';
  const today = new Date('2026-09-04T12:00:00.000Z');

  it('generates series with exactly horizonDays points, starting tomorrow, gap-free in date order', () => {
    const input: ForecastEngineInput = {
      openingBalanceMinor: 100000n,
      baseCurrency,
      horizonDays: 7,
      today,
      monthlySavingsCapacities: [
        30000n,
        30000n,
        30000n,
        30000n,
        30000n,
        30000n,
      ],
      monthsOfHistoryAvailable: 6,
      includeScenarios: false,
    };

    const result = computeForecast(input);
    expect(result.series).toHaveLength(7);
    expect(result.series[0].date).toBe('2026-09-05');
    expect(result.series[1].date).toBe('2026-09-06');
    expect(result.series[2].date).toBe('2026-09-07');
    expect(result.series[3].date).toBe('2026-09-08');
    expect(result.series[4].date).toBe('2026-09-09');
    expect(result.series[5].date).toBe('2026-09-10');
    expect(result.series[6].date).toBe('2026-09-11');
    expect(result.method).toBe(FORECAST_METHOD);
  });

  it('bounds widen strictly with n when stdDev > 0 and lowerBound <= expected <= upperBound at every point', () => {
    // Capacities with variance: 10000, 20000, 30000, 40000, 50000, 60000
    const input: ForecastEngineInput = {
      openingBalanceMinor: 100000n,
      baseCurrency,
      horizonDays: 30,
      today,
      monthlySavingsCapacities: [
        10000n,
        20000n,
        30000n,
        40000n,
        50000n,
        60000n,
      ],
      monthsOfHistoryAvailable: 6,
      includeScenarios: false,
    };

    const result = computeForecast(input);

    for (let i = 0; i < result.series.length; i++) {
      const p = result.series[i];
      const expected = BigInt(p.expected.amountMinor);
      const lower = BigInt(p.lowerBound.amountMinor);
      const upper = BigInt(p.upperBound.amountMinor);

      expect(lower <= expected).toBe(true);
      expect(expected <= upper).toBe(true);
      expect(p.expected.currency).toBe(baseCurrency);
      expect(p.lowerBound.currency).toBe(baseCurrency);
      expect(p.upperBound.currency).toBe(baseCurrency);

      if (i > 0) {
        const prevBand =
          BigInt(result.series[i - 1].upperBound.amountMinor) -
          BigInt(result.series[i - 1].expected.amountMinor);
        const currBand = upper - expected;
        // Widening bounds: band on day n >= band on day n-1
        expect(currBand >= prevBand).toBe(true);
      }
    }

    // Assert strictly wider from day 1 to day 30
    const bandDay1 =
      BigInt(result.series[0].upperBound.amountMinor) -
      BigInt(result.series[0].expected.amountMinor);
    const bandDay30 =
      BigInt(result.series[29].upperBound.amountMinor) -
      BigInt(result.series[29].expected.amountMinor);
    expect(bandDay30 > bandDay1).toBe(true);
  });

  it('negative projection: balance projected below zero stays below zero and does not clamp', () => {
    // opening 1000, monthly savings -30000 -> daily drift -1000
    const input: ForecastEngineInput = {
      openingBalanceMinor: 1000n,
      baseCurrency,
      horizonDays: 10,
      today,
      monthlySavingsCapacities: [-30000n, -30000n, -30000n],
      monthsOfHistoryAvailable: 3,
      includeScenarios: false,
    };

    const result = computeForecast(input);
    // On day 1: 1000 - 1000 = 0
    expect(result.series[0].expected.amountMinor).toBe('0');
    // On day 2: 1000 - 2000 = -1000
    expect(result.series[1].expected.amountMinor).toBe('-1000');
    // On day 10: 1000 - 10000 = -9000
    expect(result.series[9].expected.amountMinor).toBe('-9000');
    expect(BigInt(result.series[9].expected.amountMinor) < 0n).toBe(true);
    expect(BigInt(result.series[9].lowerBound.amountMinor) < 0n).toBe(true);
  });

  it('zero months of history -> flat series, confidence low, drift and band 0, assumption stated', () => {
    const input: ForecastEngineInput = {
      openingBalanceMinor: 50000n,
      baseCurrency,
      horizonDays: 5,
      today,
      monthlySavingsCapacities: [],
      monthsOfHistoryAvailable: 0,
      includeScenarios: false,
    };

    const result = computeForecast(input);
    expect(result.confidence).toBe('low');
    for (const p of result.series) {
      expect(p.expected.amountMinor).toBe('50000');
      expect(p.lowerBound.amountMinor).toBe('50000');
      expect(p.upperBound.amountMinor).toBe('50000');
    }
    expect(result.assumptions.some((a) => a.includes('0 months'))).toBe(true);
  });

  it('confidence is medium at exactly 3 months and high at exactly 6 months and low at 2 months', () => {
    const makeInput = (months: number): ForecastEngineInput => ({
      openingBalanceMinor: 50000n,
      baseCurrency,
      horizonDays: 5,
      today,
      monthlySavingsCapacities: Array(months).fill(10000n),
      monthsOfHistoryAvailable: months,
      includeScenarios: false,
    });

    expect(computeForecast(makeInput(2)).confidence).toBe('low');
    expect(computeForecast(makeInput(3)).confidence).toBe('medium');
    expect(computeForecast(makeInput(5)).confidence).toBe('medium');
    expect(computeForecast(makeInput(6)).confidence).toBe('high');
    expect(computeForecast(makeInput(12)).confidence).toBe('high');
  });

  it('includeScenarios true with completed scenario run uses run figures and states run id', () => {
    const input: ForecastEngineInput = {
      openingBalanceMinor: 100000n,
      baseCurrency,
      horizonDays: 5,
      today,
      monthlySavingsCapacities: [10000n, 10000n, 10000n],
      monthsOfHistoryAvailable: 3,
      includeScenarios: true,
      appliedScenarioRun: {
        id: '99999999-9999-4999-8999-999999999999',
        monthlySavingsCapacityMinor: '60000',
      },
    };

    const result = computeForecast(input);
    // monthly savings capacity 60000 -> daily drift 2000
    // day 1: 100000 + 2000 = 102000
    expect(result.series[0].expected.amountMinor).toBe('102000');
    expect(
      result.assumptions.some((a) =>
        a.includes('99999999-9999-4999-8999-999999999999'),
      ),
    ).toBe(true);
  });

  it('includeScenarios true with no completed run proceeds from history and states assumption', () => {
    const input: ForecastEngineInput = {
      openingBalanceMinor: 100000n,
      baseCurrency,
      horizonDays: 5,
      today,
      monthlySavingsCapacities: [30000n, 30000n, 30000n],
      monthsOfHistoryAvailable: 3,
      includeScenarios: true,
      appliedScenarioRun: null,
    };

    const result = computeForecast(input);
    // uses historical 30000 -> daily drift 1000
    expect(result.series[0].expected.amountMinor).toBe('101000');
    expect(
      result.assumptions.some(
        (a) =>
          a.toLowerCase().includes('scenarios') &&
          a.toLowerCase().includes('no completed'),
      ),
    ).toBe(true);
  });

  it('all amounts are valid strings matching integer pattern ^-?[0-9]+$', () => {
    const input: ForecastEngineInput = {
      openingBalanceMinor: -150000n,
      baseCurrency,
      horizonDays: 10,
      today,
      monthlySavingsCapacities: [15000n, 25000n, 35000n],
      monthsOfHistoryAvailable: 3,
      includeScenarios: false,
    };

    const result = computeForecast(input);
    const pattern = /^-?[0-9]+$/;
    for (const p of result.series) {
      expect(pattern.test(p.expected.amountMinor)).toBe(true);
      expect(pattern.test(p.lowerBound.amountMinor)).toBe(true);
      expect(pattern.test(p.upperBound.amountMinor)).toBe(true);
    }
  });
});
