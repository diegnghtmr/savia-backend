import { describe, expect, it } from 'vitest';
import {
  validateApprovalId,
  ApprovalQueryValidationError,
} from '../../src/approvals/approval-query.js';

describe('validateApprovalId', () => {
  it('accepts a valid UUID and normalizes to lowercase', () => {
    const validUuid = '11111111-2222-4000-8000-333333333333';
    expect(validateApprovalId(validUuid)).toBe(validUuid);
    expect(validateApprovalId(` ${validUuid.toUpperCase()} `)).toBe(validUuid);
  });

  it('rejects a non-UUID string', () => {
    expect(() => validateApprovalId('not-a-uuid')).toThrow(
      ApprovalQueryValidationError,
    );
  });

  it('rejects a non-string value', () => {
    expect(() => validateApprovalId(null)).toThrow(
      ApprovalQueryValidationError,
    );
    expect(() => validateApprovalId(123)).toThrow(ApprovalQueryValidationError);
    expect(() => validateApprovalId({})).toThrow(ApprovalQueryValidationError);
  });
});
