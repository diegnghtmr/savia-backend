import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/platform/cursor.js';
import {
  createSubscriptionListQuery,
  SubscriptionQueryValidationError,
  SUBSCRIPTION_STATUSES,
} from '../../src/recurring/subscription-query.js';

describe('createSubscriptionListQuery (RULING 61)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  it('parses valid status filters', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const query = createSubscriptionListQuery({
        workspaceId,
        statusParam: status,
      });
      expect(query.status).toBe(status);
      expect(query.workspaceId).toBe(workspaceId);
      expect(query.limit).toBe(50);
      expect(query.cursor).toBeUndefined();
    }
  });

  it('treats an OMITTED status as no filter (status: undefined)', () => {
    const query = createSubscriptionListQuery({
      workspaceId,
    });
    expect(query.status).toBeUndefined();
    expect(query.workspaceId).toBe(workspaceId);
    expect(query.limit).toBe(50);
  });

  it('rejects an unknown status with SubscriptionQueryValidationError (RULING 61: 400, not 422, not silent ignore)', () => {
    for (const invalidStatus of [
      'active',
      'paused',
      'deleted',
      'INVALID',
      '',
    ]) {
      expect(() =>
        createSubscriptionListQuery({
          workspaceId,
          statusParam: invalidStatus,
        }),
      ).toThrow(SubscriptionQueryValidationError);

      try {
        createSubscriptionListQuery({
          workspaceId,
          statusParam: invalidStatus,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(SubscriptionQueryValidationError);
        const err = error as SubscriptionQueryValidationError;
        expect(err.violations).toContainEqual(
          expect.objectContaining({
            field: 'status',
            code: 'invalid',
          }),
        );
      }
    }
  });

  it('parses valid limit and cursor params when cursor matches the status filter', () => {
    const cursor = {
      workspaceId,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000002',
      filter: 'detected' as const,
    };
    const rawCursor = encodeCursor(cursor);

    const query = createSubscriptionListQuery({
      workspaceId,
      cursorParam: rawCursor,
      limitParam: '25',
      statusParam: 'detected',
    });

    expect(query.workspaceId).toBe(workspaceId);
    expect(query.limit).toBe(25);
    expect(query.status).toBe('detected');
    expect(query.cursor).toEqual(cursor);
  });

  it('parses valid limit and cursor params when cursor matches omitted status (null filter)', () => {
    const cursor = {
      workspaceId,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000002',
      filter: null,
    };
    const rawCursor = encodeCursor(cursor);

    const query = createSubscriptionListQuery({
      workspaceId,
      cursorParam: rawCursor,
      limitParam: '25',
    });

    expect(query.workspaceId).toBe(workspaceId);
    expect(query.limit).toBe(25);
    expect(query.status).toBeUndefined();
    expect(query.cursor).toEqual(cursor);
  });

  it('rejects a cursor bound to one status when replayed under a different status', () => {
    const cursorDetected = encodeCursor({
      workspaceId,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000002',
      filter: 'detected',
    });

    expect(() =>
      createSubscriptionListQuery({
        workspaceId,
        cursorParam: cursorDetected,
        statusParam: 'confirmed',
      }),
    ).toThrow(SubscriptionQueryValidationError);
  });

  it('rejects a cursor bound to a status when replayed under no filter (omitted status)', () => {
    const cursorDetected = encodeCursor({
      workspaceId,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000002',
      filter: 'detected',
    });

    expect(() =>
      createSubscriptionListQuery({
        workspaceId,
        cursorParam: cursorDetected,
      }),
    ).toThrow(SubscriptionQueryValidationError);
  });

  it('rejects a no-filter (null) cursor when replayed under a status filter', () => {
    const cursorUnfiltered = encodeCursor({
      workspaceId,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000002',
      filter: null,
    });

    expect(() =>
      createSubscriptionListQuery({
        workspaceId,
        cursorParam: cursorUnfiltered,
        statusParam: 'detected',
      }),
    ).toThrow(SubscriptionQueryValidationError);
  });

  it('rejects a legacy 3-element cursor without filter binding', () => {
    const cursorNoFilter = encodeCursor({
      workspaceId,
      createdAt: '2026-08-29T12:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000002',
    });

    expect(() =>
      createSubscriptionListQuery({
        workspaceId,
        cursorParam: cursorNoFilter,
        statusParam: 'detected',
      }),
    ).toThrow(SubscriptionQueryValidationError);

    expect(() =>
      createSubscriptionListQuery({
        workspaceId,
        cursorParam: cursorNoFilter,
      }),
    ).toThrow(SubscriptionQueryValidationError);
  });

  it('rejects invalid limit values (0, negative, non-numeric, > 200)', () => {
    for (const invalidLimit of ['0', '-1', 'abc', '201']) {
      expect(() =>
        createSubscriptionListQuery({
          workspaceId,
          limitParam: invalidLimit,
        }),
      ).toThrow(SubscriptionQueryValidationError);
    }
  });

  it('rejects an invalid opaque cursor', () => {
    expect(() =>
      createSubscriptionListQuery({
        workspaceId,
        cursorParam: 'not-a-base64-cursor',
      }),
    ).toThrow(SubscriptionQueryValidationError);
  });
});
