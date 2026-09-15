import { describe, expect, it } from 'vitest';
import {
  freezeReportJobPayload,
  parseReportJobPayload,
  REPORT_JOB_PAYLOAD_VERSION,
} from '../../src/reports/report-job-payload.js';

const valid = {
  version: REPORT_JOB_PAYLOAD_VERSION,
  asOf: '2026-09-15T12:00:00.000Z',
  reportRunId: 'eeeeeeee-0000-4000-8000-000000000001',
  format: 'json' as const,
  definitionId: null,
  preset: 'expenses',
  filters: { from: '2026-06-01', to: '2026-06-30' },
  periodStart: '2026-06-01',
  periodTo: '2026-06-30',
  shapeTypeFilter: 'expense',
  callerType: null,
  dimensions: ['category'] as const,
  measures: ['converted_value', 'percentage'] as const,
  objectKey:
    'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001.json',
  baseCurrency: 'USD',
};

describe('parseReportJobPayload', () => {
  it('parses a frozen payload', () => {
    expect(parseReportJobPayload(freezeReportJobPayload(valid))).toEqual(valid);
  });

  it('rejects a non-object payload as a permanent failure', () => {
    expect(() => parseReportJobPayload(null)).toThrow(/must be an object/);
  });

  it('rejects unknown fields', () => {
    expect(() => parseReportJobPayload({ ...valid, extra: true })).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects missing fields', () => {
    const incomplete: Record<string, unknown> = { ...valid };
    delete incomplete.asOf;
    expect(() => parseReportJobPayload(incomplete)).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects a non-canonical asOf timestamp', () => {
    expect(() =>
      parseReportJobPayload({ ...valid, asOf: '2026-09-15T12:00:00Z' }),
    ).toThrow(/asOf/);
  });

  it('rejects an asOf timestamp with an offset', () => {
    expect(() =>
      parseReportJobPayload({
        ...valid,
        asOf: '2026-09-15T12:00:00.000+02:00',
      }),
    ).toThrow(/asOf/);
  });

  it('rejects a non-uuid reportRunId', () => {
    expect(() =>
      parseReportJobPayload({ ...valid, reportRunId: 'not-a-uuid' }),
    ).toThrow(/reportRunId/);
  });

  it('rejects a non-canonical format', () => {
    expect(() => parseReportJobPayload({ ...valid, format: 'JSON' })).toThrow(
      /format/,
    );
  });

  it('rejects a non-canonical periodStart', () => {
    expect(() =>
      parseReportJobPayload({ ...valid, periodStart: '2026-6-1' }),
    ).toThrow(/periodStart/);
  });

  it('rejects an impossible periodTo calendar date', () => {
    expect(() =>
      parseReportJobPayload({ ...valid, periodTo: '2026-02-30' }),
    ).toThrow(/periodTo/);
  });

  it('rejects a non-object filters value', () => {
    expect(() => parseReportJobPayload({ ...valid, filters: [] })).toThrow(
      /filters/,
    );
  });

  it('rejects an unknown dimension', () => {
    expect(() =>
      parseReportJobPayload({ ...valid, dimensions: ['not-a-dimension'] }),
    ).toThrow(/dimensions/);
  });

  it('rejects a per-attempt object key', () => {
    expect(() =>
      parseReportJobPayload({
        ...valid,
        objectKey:
          'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001-1.json',
      }),
    ).toThrow(/canonical/);
  });

  it('rejects an object key that does not match reportRunId', () => {
    expect(() =>
      parseReportJobPayload({
        ...valid,
        objectKey:
          'aaaaaaaa-0000-4000-8000-000000000001/ffffffff-0000-4000-8000-000000000001.json',
      }),
    ).toThrow(/objectKey must match/);
  });
});
