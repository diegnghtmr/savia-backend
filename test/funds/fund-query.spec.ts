import { describe, expect, it } from 'vitest';
import {
  createFundListQuery,
  validateFundId,
  FundQueryValidationError,
} from '../../src/funds/fund-query.js';

describe('createFundListQuery', () => {
  const validWorkspaceId = 'a0000000-0000-4000-8000-000000000001';

  it('creates query with default limit when params omitted', () => {
    const query = createFundListQuery({ workspaceId: validWorkspaceId });
    expect(query.workspaceId).toBe(validWorkspaceId);
    expect(query.limit).toBe(50);
    expect(query.cursor).toBeUndefined();
  });

  it('parses valid limitParam', () => {
    const query = createFundListQuery({
      workspaceId: validWorkspaceId,
      limitParam: '50',
    });
    expect(query.limit).toBe(50);
  });

  it('rejects invalid workspaceId', () => {
    expect(() => createFundListQuery({ workspaceId: 'not-a-uuid' })).toThrow(
      FundQueryValidationError,
    );
  });

  it('rejects invalid limitParam', () => {
    expect(() =>
      createFundListQuery({
        workspaceId: validWorkspaceId,
        limitParam: 'not-a-number',
      }),
    ).toThrow(FundQueryValidationError);

    expect(() =>
      createFundListQuery({
        workspaceId: validWorkspaceId,
        limitParam: '0',
      }),
    ).toThrow(FundQueryValidationError);

    expect(() =>
      createFundListQuery({
        workspaceId: validWorkspaceId,
        limitParam: '500',
      }),
    ).toThrow(FundQueryValidationError);
  });

  it('rejects invalid cursor format', () => {
    expect(() =>
      createFundListQuery({
        workspaceId: validWorkspaceId,
        cursorParam: 'invalid-base64!',
      }),
    ).toThrow(FundQueryValidationError);
  });
});

describe('validateFundId', () => {
  it('accepts and normalizes valid UUID', () => {
    const valid = 'A0000000-0000-4000-8000-000000000001';
    expect(validateFundId(valid)).toBe('a0000000-0000-4000-8000-000000000001');
  });

  it('rejects non-string or invalid UUID', () => {
    expect(() => validateFundId(null)).toThrow(FundQueryValidationError);
    expect(() => validateFundId(123)).toThrow(FundQueryValidationError);
    expect(() => validateFundId('invalid-uuid')).toThrow(
      FundQueryValidationError,
    );
  });
});
