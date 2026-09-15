import { describe, expect, it } from 'vitest';
import {
  createReportListQuery,
  ReportQueryValidationError,
} from '../../src/reports/report-query.js';
import { encodeCursor } from '../../src/platform/cursor.js';

describe('createReportListQuery', () => {
  const validWorkspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';

  it('parses valid minimal list query with default limit', () => {
    const result = createReportListQuery({
      workspaceId: validWorkspaceId,
    });
    expect(result).toEqual({
      workspaceId: validWorkspaceId,
      limit: 50,
    });
  });

  it('parses valid custom limit and cursor', () => {
    const cursor = encodeCursor({
      workspaceId: validWorkspaceId,
      createdAt: '2026-09-05T00:00:00.000000Z',
      id: '11111111-0000-4000-8000-000000000001',
    });

    const result = createReportListQuery({
      workspaceId: validWorkspaceId,
      cursorParam: cursor,
      limitParam: '20',
    });

    expect(result.workspaceId).toBe(validWorkspaceId);
    expect(result.limit).toBe(20);
    expect(result.cursor).toEqual({
      workspaceId: validWorkspaceId,
      createdAt: '2026-09-05T00:00:00.000000Z',
      id: '11111111-0000-4000-8000-000000000001',
    });
  });

  it('rejects invalid workspaceId', () => {
    expect(() =>
      createReportListQuery({
        workspaceId: 'invalid-uuid',
      }),
    ).toThrow(ReportQueryValidationError);
  });

  it('rejects invalid limit', () => {
    expect(() =>
      createReportListQuery({
        workspaceId: validWorkspaceId,
        limitParam: '-5',
      }),
    ).toThrow(ReportQueryValidationError);
  });

  it('rejects invalid cursor', () => {
    expect(() =>
      createReportListQuery({
        workspaceId: validWorkspaceId,
        cursorParam: 'not-a-base64-cursor',
      }),
    ).toThrow(ReportQueryValidationError);
  });
});
