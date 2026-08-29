import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/platform/cursor.js';
import {
  createRecurringRuleListQuery,
  RecurringQueryValidationError,
} from '../../src/recurring/recurring-query.js';

const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_WORKSPACE_ID = '8d0e778a-8536-41ef-a55c-f18fd2a01bf8';

describe('createRecurringRuleListQuery validation', () => {
  it('parses empty query with default limit 50 and no cursor', () => {
    const query = createRecurringRuleListQuery({ workspaceId: WORKSPACE_ID });
    expect(query.workspaceId).toBe(WORKSPACE_ID);
    expect(query.limit).toBe(50);
    expect(query.cursor).toBeUndefined();
  });

  it('parses valid limit parameter within 1..200', () => {
    const query = createRecurringRuleListQuery({
      workspaceId: WORKSPACE_ID,
      limitParam: '100',
    });
    expect(query.limit).toBe(100);
  });

  it('parses valid base64 cursor matching expected workspace', () => {
    const cursorStr = encodeCursor({
      workspaceId: WORKSPACE_ID,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });
    const query = createRecurringRuleListQuery({
      workspaceId: WORKSPACE_ID,
      cursorParam: cursorStr,
    });
    expect(query.cursor).toEqual({
      workspaceId: WORKSPACE_ID,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });
  });

  it('rejects cursor encoded for a different workspace', () => {
    const cursorStr = encodeCursor({
      workspaceId: OTHER_WORKSPACE_ID,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });
    expect(() =>
      createRecurringRuleListQuery({
        workspaceId: WORKSPACE_ID,
        cursorParam: cursorStr,
      }),
    ).toThrow(RecurringQueryValidationError);
  });

  it('rejects limit less than 1 or greater than 200', () => {
    expect(() =>
      createRecurringRuleListQuery({
        workspaceId: WORKSPACE_ID,
        limitParam: '0',
      }),
    ).toThrow(RecurringQueryValidationError);

    expect(() =>
      createRecurringRuleListQuery({
        workspaceId: WORKSPACE_ID,
        limitParam: '201',
      }),
    ).toThrow(RecurringQueryValidationError);
  });

  it('rejects non-numeric limit', () => {
    expect(() =>
      createRecurringRuleListQuery({
        workspaceId: WORKSPACE_ID,
        limitParam: 'abc',
      }),
    ).toThrow(RecurringQueryValidationError);
  });
});
