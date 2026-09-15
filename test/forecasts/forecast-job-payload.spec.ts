import { describe, expect, it } from 'vitest';
import {
  FORECAST_JOB_PAYLOAD_VERSION,
  freezeForecastJobPayload,
  parseForecastJobPayload,
} from '../../src/forecasts/forecast-job-payload.js';

const valid = {
  version: FORECAST_JOB_PAYLOAD_VERSION,
  asOf: '2026-09-04T12:00:00.000Z',
  horizonDays: 30,
  includeScenarios: false,
  effectiveAccountIds: ['11111111-0000-4000-8000-000000000001'],
  closedAccountAssumptions: ['Account closed'],
  baseCurrency: 'USD',
};

describe('parseForecastJobPayload', () => {
  it('parses a frozen payload', () => {
    expect(parseForecastJobPayload(freezeForecastJobPayload(valid))).toEqual(
      valid,
    );
  });

  it('rejects a non-object payload as a permanent failure', () => {
    expect(() => parseForecastJobPayload(null)).toThrow(/must be an object/);
  });

  it('rejects unknown fields', () => {
    expect(() => parseForecastJobPayload({ ...valid, extra: true })).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects an invalid asOf timestamp', () => {
    expect(() =>
      parseForecastJobPayload({ ...valid, asOf: 'not-a-date' }),
    ).toThrow(/asOf/);
  });

  it('rejects a non-ISO asOf timestamp', () => {
    expect(() =>
      parseForecastJobPayload({ ...valid, asOf: 'September 4, 2026' }),
    ).toThrow(/asOf/);
  });

  it('rejects a date-only asOf timestamp', () => {
    expect(() =>
      parseForecastJobPayload({ ...valid, asOf: '2026-09-04' }),
    ).toThrow(/asOf/);
  });

  it('rejects an asOf timestamp with an offset', () => {
    expect(() =>
      parseForecastJobPayload({
        ...valid,
        asOf: '2026-09-04T12:00:00.000+02:00',
      }),
    ).toThrow(/asOf/);
  });

  it('rejects an impossible calendar asOf timestamp', () => {
    expect(() =>
      parseForecastJobPayload({
        ...valid,
        asOf: '2026-02-30T00:00:00.000Z',
      }),
    ).toThrow(/asOf/);
  });

  it('rejects an asOf timestamp missing milliseconds', () => {
    expect(() =>
      parseForecastJobPayload({ ...valid, asOf: '2026-09-04T12:00:00Z' }),
    ).toThrow(/asOf/);
  });

  it('rejects a non-uuid effectiveAccountId', () => {
    expect(() =>
      parseForecastJobPayload({ ...valid, effectiveAccountIds: ['nope'] }),
    ).toThrow(/effectiveAccountIds/);
  });
});
