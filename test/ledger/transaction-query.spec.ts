import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/platform/cursor.js';
import {
  createTransactionListQuery,
  TransactionQueryValidationError,
} from '../../src/ledger/transaction-query.js';

describe('createTransactionListQuery', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';
  const categoryId = '00000000-0000-0000-0000-000000000c01';

  it('creates default list query with limit 50 and no filters', () => {
    const query = createTransactionListQuery({ workspaceId });
    expect(query).toEqual({
      workspaceId,
      limit: 50,
    });
  });

  it('parses custom limit within 1..200', () => {
    const query = createTransactionListQuery({
      workspaceId,
      limitParam: '25',
    });
    expect(query).toEqual({
      workspaceId,
      limit: 25,
    });
  });

  it('parses valid cursor', () => {
    const rawCursor = encodeCursor({
      createdAt: '2026-08-20T10:00:00.123456Z',
      id: accountId,
    });
    const query = createTransactionListQuery({
      workspaceId,
      cursorParam: rawCursor,
    });
    expect(query.cursor).toEqual({
      createdAt: '2026-08-20T10:00:00.123456Z',
      id: accountId,
    });
  });

  it('parses all valid query filters together', () => {
    const query = createTransactionListQuery({
      workspaceId,
      accountIdParam: accountId,
      fromParam: '2026-08-01',
      toParam: '2026-08-31',
      categoryIdParam: categoryId,
      statusParam: 'confirmed',
      queryParam: 'Groceries store',
    });
    expect(query).toEqual({
      workspaceId,
      limit: 50,
      accountId,
      from: '2026-08-01',
      to: '2026-08-31',
      categoryId,
      status: 'confirmed',
      query: 'Groceries store',
    });
  });

  it('throws TransactionQueryValidationError for malformed limit (non-integer)', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        limitParam: 'not-a-number',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for out-of-range limit (< 1 or > 200)', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        limitParam: '0',
      }),
    ).toThrow(TransactionQueryValidationError);

    expect(() =>
      createTransactionListQuery({
        workspaceId,
        limitParam: '201',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for malformed cursor', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        cursorParam: 'invalid-cursor-payload',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for invalid accountId (not a UUID)', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        accountIdParam: 'not-a-uuid',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for invalid categoryId (not a UUID)', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        categoryIdParam: 'not-a-uuid',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for invalid from date', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        fromParam: 'invalid-date',
      }),
    ).toThrow(TransactionQueryValidationError);

    expect(() =>
      createTransactionListQuery({
        workspaceId,
        fromParam: '2026-02-30',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for invalid to date', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        toParam: 'invalid-date',
      }),
    ).toThrow(TransactionQueryValidationError);

    expect(() =>
      createTransactionListQuery({
        workspaceId,
        toParam: '2026-13-01',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for bad status value', () => {
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        statusParam: 'nonexistent_status',
      }),
    ).toThrow(TransactionQueryValidationError);
  });

  it('throws TransactionQueryValidationError for over-length query (> 200 characters)', () => {
    const longQuery = 'a'.repeat(201);
    expect(() =>
      createTransactionListQuery({
        workspaceId,
        queryParam: longQuery,
      }),
    ).toThrow(TransactionQueryValidationError);

    // 200 chars should be accepted
    const exactQuery = 'a'.repeat(200);
    const result = createTransactionListQuery({
      workspaceId,
      queryParam: exactQuery,
    });
    expect(result.query).toBe(exactQuery);
  });

  it('accumulates multiple field violations together', () => {
    try {
      createTransactionListQuery({
        workspaceId,
        limitParam: '999',
        accountIdParam: 'bad-acc',
        statusParam: 'bad-status',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionQueryValidationError);
      const valError = error as TransactionQueryValidationError;
      expect(valError.violations.map((v) => v.field)).toEqual(
        expect.arrayContaining(['limit', 'accountId', 'status']),
      );
    }
  });
});
