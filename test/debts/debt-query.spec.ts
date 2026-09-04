import { describe, expect, it } from 'vitest';
import {
  createDebtListQuery,
  validateDebtId,
  DebtQueryValidationError,
} from '../../src/debts/debt-query.js';

describe('createDebtListQuery', () => {
  const validWorkspaceId = 'a0000000-0000-4000-8000-000000000001';

  it('creates query with default limit when params omitted', () => {
    const query = createDebtListQuery({ workspaceId: validWorkspaceId });
    expect(query.workspaceId).toBe(validWorkspaceId);
    expect(query.limit).toBe(50);
    expect(query.cursor).toBeUndefined();
  });

  it('parses valid limitParam', () => {
    const query = createDebtListQuery({
      workspaceId: validWorkspaceId,
      limitParam: '50',
    });
    expect(query.limit).toBe(50);
  });

  it('rejects invalid workspaceId', () => {
    expect(() => createDebtListQuery({ workspaceId: 'not-a-uuid' })).toThrow(
      DebtQueryValidationError,
    );
  });

  it('rejects invalid limitParam', () => {
    expect(() =>
      createDebtListQuery({
        workspaceId: validWorkspaceId,
        limitParam: 'not-a-number',
      }),
    ).toThrow(DebtQueryValidationError);

    expect(() =>
      createDebtListQuery({
        workspaceId: validWorkspaceId,
        limitParam: '0',
      }),
    ).toThrow(DebtQueryValidationError);

    expect(() =>
      createDebtListQuery({
        workspaceId: validWorkspaceId,
        limitParam: '500',
      }),
    ).toThrow(DebtQueryValidationError);
  });

  it('rejects invalid cursor format', () => {
    expect(() =>
      createDebtListQuery({
        workspaceId: validWorkspaceId,
        cursorParam: 'invalid-base64!',
      }),
    ).toThrow(DebtQueryValidationError);
  });
});

describe('validateDebtId', () => {
  it('accepts valid UUID', () => {
    const valid = 'a0000000-0000-4000-8000-000000000001';
    expect(validateDebtId(valid)).toBe(valid);
  });

  it('normalizes UUID to lowercase', () => {
    const upper = 'A0000000-0000-4000-8000-000000000001';
    expect(validateDebtId(upper)).toBe(upper.toLowerCase());
  });

  it('rejects invalid UUID format', () => {
    expect(() => validateDebtId('not-a-uuid')).toThrow(
      DebtQueryValidationError,
    );
    expect(() => validateDebtId(123)).toThrow(DebtQueryValidationError);
    expect(() => validateDebtId(null)).toThrow(DebtQueryValidationError);
  });
});
