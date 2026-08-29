import {
  add,
  nameValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CreateNamedResourceCommand } from './catalogs.port.js';

export class CatalogCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Catalog command validation failed.');
    this.name = 'CatalogCommandValidationError';
  }
}

const ALLOWED_FIELDS = ['name'] as const;

export function createNamedResourceCommand(
  input: unknown,
): CreateNamedResourceCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new CatalogCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  const name = nameValue(body.name, 'name', violations, 120);

  if (violations.length > 0) {
    throw new CatalogCommandValidationError(sortViolations(violations));
  }

  return { name };
}

export const createTagCommand = createNamedResourceCommand;
export const createPayeeCommand = createNamedResourceCommand;
