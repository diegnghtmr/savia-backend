import { describe, expect, it } from 'vitest';
import {
  exportArtifactObjectKey,
  freezeExportJobPayload,
  parseExportJobPayload,
  EXPORT_JOB_PAYLOAD_VERSION,
  type ExportJobPayload,
} from '../../src/exports/export-job-payload.js';

const valid: ExportJobPayload = {
  version: EXPORT_JOB_PAYLOAD_VERSION,
  asOf: '2026-09-16T12:00:00.000Z',
  exportJobId: 'eeeeeeee-0000-4000-8000-000000000001',
  format: 'csv',
  resource: 'all',
  resourceId: null,
  from: '2026-06-01',
  to: '2026-06-30',
  objectKey:
    'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001.csv',
};

describe('parseExportJobPayload', () => {
  it('parses a frozen payload', () => {
    expect(parseExportJobPayload(freezeExportJobPayload(valid))).toEqual(valid);
  });

  it('rejects a non-object payload as a permanent failure', () => {
    expect(() => parseExportJobPayload(null)).toThrow(/must be an object/);
  });

  it('rejects unknown fields', () => {
    expect(() => parseExportJobPayload({ ...valid, extra: true })).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects missing fields', () => {
    const incomplete: Record<string, unknown> = { ...valid };
    delete incomplete.asOf;
    expect(() => parseExportJobPayload(incomplete)).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects unsupported version', () => {
    expect(() =>
      parseExportJobPayload({ ...valid, version: 2 as unknown as 1 }),
    ).toThrow(/version/);
  });

  it('rejects a non-canonical asOf timestamp', () => {
    expect(() =>
      parseExportJobPayload({ ...valid, asOf: '2026-09-16T12:00:00Z' }),
    ).toThrow(/asOf/);
  });

  it('rejects an asOf timestamp with an offset', () => {
    expect(() =>
      parseExportJobPayload({
        ...valid,
        asOf: '2026-09-16T12:00:00.000+02:00',
      }),
    ).toThrow(/asOf/);
  });

  it('rejects a non-uuid exportJobId', () => {
    expect(() =>
      parseExportJobPayload({ ...valid, exportJobId: 'not-a-uuid' }),
    ).toThrow(/exportJobId/);
  });

  it('rejects an unsupported format', () => {
    expect(() =>
      parseExportJobPayload({ ...valid, format: 'pdf' as unknown as 'csv' }),
    ).toThrow(/format/);
  });

  it('rejects an unsupported resource', () => {
    expect(() =>
      parseExportJobPayload({
        ...valid,
        resource: 'unknown' as unknown as 'all',
      }),
    ).toThrow(/resource/);
  });

  it('rejects a non-uuid resourceId', () => {
    expect(() =>
      parseExportJobPayload({ ...valid, resourceId: 'invalid-uuid' }),
    ).toThrow(/resourceId/);
  });

  it('rejects a non-canonical from date', () => {
    expect(() => parseExportJobPayload({ ...valid, from: '2026-6-1' })).toThrow(
      /from/,
    );
  });

  it('rejects an impossible to calendar date', () => {
    expect(() => parseExportJobPayload({ ...valid, to: '2026-02-30' })).toThrow(
      /to/,
    );
  });

  it('rejects a non-canonical object key', () => {
    expect(() =>
      parseExportJobPayload({
        ...valid,
        objectKey: 'not-a-canonical-key',
      }),
    ).toThrow(/canonical/);
  });

  it('rejects an object key whose extension does not match format', () => {
    expect(() =>
      parseExportJobPayload({
        ...valid,
        format: 'json_backup',
        objectKey:
          'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001.csv',
      }),
    ).toThrow(/format extension/);
  });

  it('rejects an object key that does not match exportJobId', () => {
    expect(() =>
      parseExportJobPayload({
        ...valid,
        objectKey:
          'aaaaaaaa-0000-4000-8000-000000000001/ffffffff-0000-4000-8000-000000000001.csv',
      }),
    ).toThrow(/exportJobId/);
  });

  it('rejects an object key bound to a foreign workspace', () => {
    expect(() =>
      parseExportJobPayload(valid, 'bbbbbbbb-0000-4000-8000-000000000001'),
    ).toThrow(/workspace/);
  });

  it('accepts an object key bound to the job workspace', () => {
    expect(
      parseExportJobPayload(valid, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toEqual(valid);
  });

  it('constructs correct object keys for json_backup format', () => {
    const key = exportArtifactObjectKey(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'eeeeeeee-0000-4000-8000-000000000001',
      'json_backup',
    );
    expect(key).toBe(
      'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001.json',
    );
  });
});
