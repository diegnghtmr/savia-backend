import { UUID_PATTERN } from '../platform/uuid.js';
import type { FieldViolation } from '../platform/problem-details.js';

export class ReconciliationQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Reconciliation query validation failed.');
    this.name = 'ReconciliationQueryValidationError';
  }
}

export function validateReconciliationId(reconciliationId: unknown): string {
  if (
    typeof reconciliationId !== 'string' ||
    !UUID_PATTERN.test(reconciliationId.trim())
  ) {
    throw new ReconciliationQueryValidationError([
      Object.freeze({
        field: 'reconciliationId',
        code: 'invalid',
        message: 'reconciliationId must be a valid UUID.',
      }),
    ]);
  }
  return reconciliationId.trim().toLowerCase();
}
