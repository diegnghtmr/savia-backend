import {
  add,
  enumValue,
  nameValue,
  nullableStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  CATEGORY_KINDS,
  type CreateCategoryCommand,
  type CreateNamedResourceCommand,
} from './catalogs.port.js';

export class CatalogCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Catalog command validation failed.');
    this.name = 'CatalogCommandValidationError';
  }
}

const ALLOWED_NAMED_RESOURCE_FIELDS = ['name'] as const;
const ALLOWED_CATEGORY_FIELDS = [
  'name',
  'kind',
  'parentId',
  'icon',
  'colorToken',
] as const;

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
    if (
      !ALLOWED_NAMED_RESOURCE_FIELDS.includes(
        key as (typeof ALLOWED_NAMED_RESOURCE_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  const name = nameValue(body.name, 'name', violations, 120);

  if (violations.length > 0) {
    throw new CatalogCommandValidationError(sortViolations(violations));
  }

  return { name };
}

export function createCategoryCommand(input: unknown): CreateCategoryCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new CatalogCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (
      !ALLOWED_CATEGORY_FIELDS.includes(
        key as (typeof ALLOWED_CATEGORY_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  const name = nameValue(body.name, 'name', violations, 120);
  const kind = enumValue(
    body.kind,
    'kind',
    CATEGORY_KINDS,
    violations,
    'must be one of income, expense, transfer, other',
  );

  let parentId: string | null = null;
  if (body.parentId !== undefined && body.parentId !== null) {
    if (
      typeof body.parentId !== 'string' ||
      !UUID_PATTERN.test(body.parentId)
    ) {
      add(violations, 'parentId', 'invalid-format', 'must be a valid UUID');
    } else {
      parentId = body.parentId;
    }
  }

  const icon = nullableStringValue(body.icon, 'icon', violations);
  const colorToken = nullableStringValue(
    body.colorToken,
    'colorToken',
    violations,
  );

  if (violations.length > 0) {
    throw new CatalogCommandValidationError(sortViolations(violations));
  }

  return {
    name,
    kind,
    parentId,
    icon,
    colorToken,
  };
}

export const createTagCommand = createNamedResourceCommand;
export const createPayeeCommand = createNamedResourceCommand;
