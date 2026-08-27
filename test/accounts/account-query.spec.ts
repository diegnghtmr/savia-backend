import { describe, expect, it } from 'vitest';
import {
  createAccountBalanceQuery,
  createAccountListQuery,
  AccountQueryValidationError,
} from '../../src/accounts/account-query.js';

describe('createAccountBalanceQuery', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('creates query without asOf when not provided', () => {
    const query = createAccountBalanceQuery({
      workspaceId,
      accountId,
    });
    expect(query).toEqual({
      workspaceId,
      accountId,
    });
  });

  it('creates query with valid ISO 8601 date-time asOf', () => {
    const asOf = '2026-07-15T12:30:00.000Z';
    const query = createAccountBalanceQuery({
      workspaceId,
      accountId,
      asOfParam: asOf,
    });
    expect(query).toEqual({
      workspaceId,
      accountId,
      asOf,
    });
  });

  it('throws AccountQueryValidationError when asOf is not a valid date-time', () => {
    expect(() =>
      createAccountBalanceQuery({
        workspaceId,
        accountId,
        asOfParam: 'invalid-date',
      }),
    ).toThrow(AccountQueryValidationError);
  });

  it('throws AccountQueryValidationError when asOf is a plain date without time', () => {
    expect(() =>
      createAccountBalanceQuery({
        workspaceId,
        accountId,
        asOfParam: '2026-07-15',
      }),
    ).toThrow(AccountQueryValidationError);
  });
});

describe('createAccountListQuery', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';

  it('creates default list query', () => {
    const query = createAccountListQuery({ workspaceId });
    expect(query).toEqual({
      workspaceId,
      limit: 50,
    });
  });

  it('validates status filter', () => {
    const query = createAccountListQuery({
      workspaceId,
      statusParam: 'active',
    });
    expect(query).toEqual({
      workspaceId,
      limit: 50,
      status: 'active',
    });
  });

  it('throws AccountQueryValidationError for unsupported status', () => {
    expect(() =>
      createAccountListQuery({
        workspaceId,
        statusParam: 'unknown_status',
      }),
    ).toThrow(AccountQueryValidationError);
  });
});
