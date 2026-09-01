import { describe, expect, it } from 'vitest';
import {
  validateReconciliationId,
  ReconciliationQueryValidationError,
} from '../../src/reconciliations/reconciliation-query.js';

describe('validateReconciliationId', () => {
  it('accepts valid UUID and returns lowercase trimmed string', () => {
    const validUuid = '00000000-0000-0000-0000-000000007001';
    expect(validateReconciliationId(validUuid)).toBe(validUuid);
    expect(validateReconciliationId(`  ${validUuid.toUpperCase()}  `)).toBe(
      validUuid,
    );
  });

  it('rejects invalid or non-string input', () => {
    expect(() => validateReconciliationId('not-a-uuid')).toThrow(
      ReconciliationQueryValidationError,
    );
    expect(() => validateReconciliationId('')).toThrow(
      ReconciliationQueryValidationError,
    );
    expect(() => validateReconciliationId(null)).toThrow(
      ReconciliationQueryValidationError,
    );
    expect(() => validateReconciliationId(undefined)).toThrow(
      ReconciliationQueryValidationError,
    );
    expect(() => validateReconciliationId(12345)).toThrow(
      ReconciliationQueryValidationError,
    );
  });
});
