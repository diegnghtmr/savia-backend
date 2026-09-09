import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CliDeviceAuthorizationCommand } from './cli-device.port.js';

const FIELDS = ['clientId', 'scopes'] as const;
export class CliDeviceCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('CLI device authorization validation failed.');
  }
}

export function createCliDeviceAuthorizationCommand(
  input: unknown,
): CliDeviceAuthorizationCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new CliDeviceCommandValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  if (typeof body.clientId !== 'string' || body.clientId.length === 0)
    add(
      violations,
      'clientId',
      'required',
      'is required and must be a non-empty string',
    );
  const rawScopes = body.scopes;
  const scopes =
    rawScopes === undefined
      ? []
      : Array.isArray(rawScopes)
        ? rawScopes.filter(
            (scope): scope is string => typeof scope === 'string',
          )
        : [];
  if (
    rawScopes !== undefined &&
    (!Array.isArray(rawScopes) || scopes.length !== rawScopes.length)
  )
    add(violations, 'scopes', 'invalid-items', 'must be an array of strings');
  if (new Set(scopes).size !== scopes.length)
    add(violations, 'scopes', 'unique-items', 'must not contain duplicates');
  if (violations.length)
    throw new CliDeviceCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return { clientId: body.clientId as string, scopes };
}
