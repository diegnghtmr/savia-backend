import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CliDeviceApprovalCommand } from './cli-device.port.js';

const FIELDS = ['userCode'] as const;
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export class CliDeviceApprovalCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('CLI device approval validation failed.');
  }
}

export function createCliDeviceApprovalCommand(
  input: unknown,
): CliDeviceApprovalCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new CliDeviceApprovalCommandValidationError(
      sortViolations(violations),
    );
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');

  const rawUserCode = body.userCode;
  if (typeof rawUserCode !== 'string') {
    add(violations, 'userCode', 'required', 'is required and must be a string');
  } else if ([...rawUserCode].length > 16) {
    add(violations, 'userCode', 'max-length', 'must be at most 16 characters');
  } else {
    const userCode = rawUserCode.replace(/[\s-]/gu, '').toUpperCase();
    if (!USER_CODE_PATTERN.test(userCode))
      add(
        violations,
        'userCode',
        'invalid-format',
        'must be an 8-character user code',
      );
  }
  if (violations.length)
    throw new CliDeviceApprovalCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return {
    userCode: (rawUserCode as string).replace(/[\s-]/gu, '').toUpperCase(),
  };
}
