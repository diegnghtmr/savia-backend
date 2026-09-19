import { describe, expect, it } from 'vitest';
import {
  parseReportArtifactObjectKey,
  reportArtifactObjectKey,
} from '../../src/reports/report-run-snapshot.js';

const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
const resourceId = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('reportArtifactObjectKey', () => {
  it('computes the deterministic object key at request time', () => {
    expect(reportArtifactObjectKey(workspaceId, resourceId, 'json')).toBe(
      `${workspaceId}/${resourceId}.json`,
    );
    expect(reportArtifactObjectKey(workspaceId, resourceId, 'csv')).toBe(
      `${workspaceId}/${resourceId}.csv`,
    );
    expect(reportArtifactObjectKey(workspaceId, resourceId, 'pdf')).toBe(
      `${workspaceId}/${resourceId}.pdf`,
    );
  });
});

describe('parseReportArtifactObjectKey', () => {
  it('parses a canonical object key', () => {
    expect(
      parseReportArtifactObjectKey(`${workspaceId}/${resourceId}.json`),
    ).toEqual({
      workspaceId,
      resourceId,
      format: 'json',
    });
  });

  it('rejects an uppercase UUID as non-canonical', () => {
    expect(() =>
      parseReportArtifactObjectKey(
        `${workspaceId.toUpperCase()}/${resourceId}.json`,
      ),
    ).toThrow(/canonical/);
  });

  it('rejects a missing slash', () => {
    expect(() =>
      parseReportArtifactObjectKey(`${workspaceId}${resourceId}.json`),
    ).toThrow(/canonical/);
  });

  it('rejects extra path segments', () => {
    expect(() =>
      parseReportArtifactObjectKey(
        `${workspaceId}/attempts/1/${resourceId}.json`,
      ),
    ).toThrow(/canonical/);
  });

  it('rejects a path traversal segment', () => {
    expect(() =>
      parseReportArtifactObjectKey(`${workspaceId}/../${resourceId}.json`),
    ).toThrow(/canonical/);
  });

  it('rejects an unsupported extension', () => {
    expect(() =>
      parseReportArtifactObjectKey(`${workspaceId}/${resourceId}.xlsx`),
    ).toThrow(/canonical/);
  });

  it('rejects a non-uuid workspace id', () => {
    expect(() =>
      parseReportArtifactObjectKey(`not-a-workspace/${resourceId}.json`),
    ).toThrow(/canonical/);
  });

  it('rejects a non-uuid resource id', () => {
    expect(() =>
      parseReportArtifactObjectKey(`${workspaceId}/not-a-resource.json`),
    ).toThrow(/canonical/);
  });

  it('rejects a leading slash', () => {
    expect(() =>
      parseReportArtifactObjectKey(`/${workspaceId}/${resourceId}.json`),
    ).toThrow(/canonical/);
  });

  it('rejects a trailing extra suffix', () => {
    expect(() =>
      parseReportArtifactObjectKey(`${workspaceId}/${resourceId}.json.bak`),
    ).toThrow(/canonical/);
  });
});
