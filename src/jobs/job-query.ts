import { UUID_PATTERN } from '../platform/uuid.js';
import type { FieldViolation } from '../platform/problem-details.js';

export class JobQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Job query validation failed.');
    this.name = 'JobQueryValidationError';
  }
}

export function validateJobId(jobId: unknown): string {
  if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId.trim())) {
    throw new JobQueryValidationError([
      Object.freeze({
        field: 'jobId',
        code: 'invalid',
        message: 'jobId must be a valid UUID.',
      }),
    ]);
  }
  return jobId.trim().toLowerCase();
}
