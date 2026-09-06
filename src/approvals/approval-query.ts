import { UUID_PATTERN } from '../platform/uuid.js';
import type { FieldViolation } from '../platform/problem-details.js';

export class ApprovalQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Approval query validation failed.');
    this.name = 'ApprovalQueryValidationError';
  }
}

export function validateApprovalId(approvalId: unknown): string {
  if (typeof approvalId !== 'string' || !UUID_PATTERN.test(approvalId.trim())) {
    throw new ApprovalQueryValidationError([
      Object.freeze({
        field: 'approvalId',
        code: 'invalid',
        message: 'approvalId must be a valid UUID.',
      }),
    ]);
  }
  return approvalId.trim().toLowerCase();
}
