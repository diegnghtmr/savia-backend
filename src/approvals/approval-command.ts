import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { ApprovalDecisionCommand } from './approval.port.js';

export class ApprovalCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Approval command validation failed.');
    this.name = 'ApprovalCommandValidationError';
  }
}

const TOP_LEVEL_FIELDS = ['argumentsHash', 'reason'] as const;

export function createApprovalDecisionCommand(
  input: unknown,
): ApprovalDecisionCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ApprovalCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;

  Object.keys(body).forEach((key) => {
    if (!TOP_LEVEL_FIELDS.includes(key as (typeof TOP_LEVEL_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  });

  const argumentsHashRaw = body.argumentsHash;
  if (typeof argumentsHashRaw !== 'string') {
    add(
      violations,
      'argumentsHash',
      'invalid-type',
      'must be a non-empty string',
    );
  } else if (argumentsHashRaw.includes('\0')) {
    add(
      violations,
      'argumentsHash',
      'invalid-characters',
      'must not contain null characters',
    );
  } else if (argumentsHashRaw.trim().length === 0) {
    add(violations, 'argumentsHash', 'required', 'must be a non-empty string');
  }

  let reason: string | null = null;
  const reasonRaw = body.reason;
  if (reasonRaw !== null && reasonRaw !== undefined) {
    if (typeof reasonRaw !== 'string') {
      add(violations, 'reason', 'invalid-type', 'must be a string or null');
    } else if (reasonRaw.includes('\0')) {
      add(
        violations,
        'reason',
        'invalid-characters',
        'must not contain null characters',
      );
    } else if ([...reasonRaw].length > 500) {
      add(violations, 'reason', 'max-length', 'must be at most 500 characters');
    } else {
      reason = reasonRaw;
    }
  }

  if (violations.length > 0) {
    throw new ApprovalCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    argumentsHash: argumentsHashRaw as string,
    reason,
  };
}
