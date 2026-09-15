import { describe, expect, it } from 'vitest';
import {
  computeBalanceForecast,
  ForecastMissingRateError,
} from '../../src/forecasts/forecast-computation.js';

const asOf = new Date('2026-09-04T12:00:00.000Z');

describe('computeBalanceForecast', () => {
  it('converts non-base currency using the frozen rate', () => {
    const result = computeBalanceForecast({
      baseCurrency: 'USD',
      horizonDays: 30,
      asOf,
      includeScenarios: false,
      closedAccountAssumptions: [],
      accountBalances: [
        { id: 'acct-eur', currency: 'EUR', nativeBalanceMinor: '10000' },
      ],
      flowRows: [],
      rates: new Map([['EUR:USD', '1.10']]),
      appliedScenarioRun: null,
    });
    expect(result.series[0]?.expected.amountMinor).toBe('11000');
  });

  it('throws ForecastMissingRateError when a required rate is absent', () => {
    expect(() =>
      computeBalanceForecast({
        baseCurrency: 'USD',
        horizonDays: 30,
        asOf,
        includeScenarios: false,
        closedAccountAssumptions: [],
        accountBalances: [
          { id: 'acct-eur', currency: 'EUR', nativeBalanceMinor: '1000' },
        ],
        flowRows: [],
        rates: new Map(),
        appliedScenarioRun: null,
      }),
    ).toThrow(ForecastMissingRateError);
  });

  it('prepends closed-account assumptions and uses only open balances', () => {
    const closedId = '22222222-0000-4000-8000-000000000002';
    const result = computeBalanceForecast({
      baseCurrency: 'USD',
      horizonDays: 30,
      asOf,
      includeScenarios: false,
      closedAccountAssumptions: [
        `Account ${closedId} is closed and contributes zero.`,
      ],
      accountBalances: [
        { id: 'open', currency: 'USD', nativeBalanceMinor: '50000' },
      ],
      flowRows: [],
      rates: new Map(),
      appliedScenarioRun: null,
    });
    expect(result.assumptions).toContain(
      `Account ${closedId} is closed and contributes zero.`,
    );
    expect(result.series[0]?.expected.amountMinor).toBe('50000');
  });

  it('applies a completed scenario run when includeScenarios is true', () => {
    const result = computeBalanceForecast({
      baseCurrency: 'USD',
      horizonDays: 30,
      asOf,
      includeScenarios: true,
      closedAccountAssumptions: [],
      accountBalances: [],
      flowRows: [],
      rates: new Map(),
      appliedScenarioRun: {
        id: 'scen-run-123',
        monthlySavingsCapacityMinor: '60000',
      },
    });
    expect(result.assumptions).toContain('Applied scenario run scen-run-123.');
    expect(result.series[0]?.expected.amountMinor).toBe('2000');
  });

  it('records the missing-scenario assumption when includeScenarios is true and no run exists', () => {
    const result = computeBalanceForecast({
      baseCurrency: 'USD',
      horizonDays: 30,
      asOf,
      includeScenarios: true,
      closedAccountAssumptions: [],
      accountBalances: [],
      flowRows: [],
      rates: new Map(),
      appliedScenarioRun: null,
    });
    expect(result.assumptions).toContain(
      'includeScenarios was requested but no completed scenario run existed; proceeded from history.',
    );
  });

  it('counts only buckets with rows for monthsOfHistoryAvailable and trims leading empty buckets', () => {
    const result = computeBalanceForecast({
      baseCurrency: 'USD',
      horizonDays: 30,
      asOf,
      includeScenarios: false,
      closedAccountAssumptions: [],
      accountBalances: [],
      flowRows: [
        {
          id: 'tx-1',
          type: 'income',
          amountMinor: '30000',
          currency: 'USD',
          occurredAt: new Date('2026-07-15T00:00:00.000Z'),
        },
        {
          id: 'tx-2',
          type: 'income',
          amountMinor: '30000',
          currency: 'USD',
          occurredAt: new Date('2026-08-15T00:00:00.000Z'),
        },
      ],
      rates: new Map(),
      appliedScenarioRun: null,
    });
    expect(result.confidence).toBe('low');
    expect(result.assumptions).toContain('3 month(s) of history used.');
  });
});
