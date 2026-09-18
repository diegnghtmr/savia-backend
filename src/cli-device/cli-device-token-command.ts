import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CliDeviceTokenCommand } from './cli-device.port.js';

const FIELDS = ['clientId', 'deviceCode'] as const;
export class CliDeviceTokenCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('CLI device token validation failed.');
  }
}

export function createCliDeviceTokenCommand(
  input: unknown,
): CliDeviceTokenCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new CliDeviceTokenCommandValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  for (const field of FIELDS)
    if (
      typeof body[field] !== 'string' ||
      [...(body[field] as string)].length === 0
    )
      add(
        violations,
        field,
        'required',
        'is required and must be a non-empty string',
      );
  if (violations.length)
    throw new CliDeviceTokenCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return {
    clientId: body.clientId as string,
    deviceCode: body.deviceCode as string,
  };
}
