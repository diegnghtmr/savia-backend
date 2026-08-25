import {
  add,
  currencyValue,
  nameValue,
  stringValue,
  type FieldViolation,
} from './bootstrap-command.js';
import type { WorkspaceKind } from './workspace-kind.js';

// prettier-ignore
const WORKSPACE_CREATE_FIELDS = ['name', 'kind', 'baseCurrency'] as const;
const ALLOWED_KINDS = ['family', 'shared'] as const;

// prettier-ignore
const WORKSPACE_UPDATE_FIELDS = ['name', 'baseCurrency'] as const;

export interface WorkspaceCreateCommand {
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly baseCurrency: string;
}

export interface WorkspaceUpdateCommand {
  readonly name?: string;
  readonly baseCurrency?: string;
}

export class WorkspaceCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Workspace command validation failed.');
  }
}

export function createWorkspaceCreateCommand(
  input: unknown,
): WorkspaceCreateCommand {
  const violations: FieldViolation[] = [];
  const body = readCreateBody(input, violations);

  const name = nameValue(body.name, 'name', violations);
  const baseCurrency = currencyValue(
    body.baseCurrency,
    'baseCurrency',
    violations,
  );

  let kind: WorkspaceKind = 'family';
  if (body.kind !== undefined) {
    const rawKind = stringValue(body.kind, 'kind', violations);
    if (ALLOWED_KINDS.includes(rawKind as (typeof ALLOWED_KINDS)[number])) {
      kind = rawKind as WorkspaceKind;
    } else {
      add(violations, 'kind', 'unsupported', 'kind must be family or shared');
    }
  }

  if (violations.length > 0) {
    violations.sort(
      (left, right) =>
        left.field.localeCompare(right.field) ||
        left.message.localeCompare(right.message),
    );
    throw new WorkspaceCommandValidationError(violations);
  }

  return Object.freeze({
    name,
    kind,
    baseCurrency,
  });
}

function readCreateBody(
  input: unknown,
  violations: FieldViolation[],
): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    return {};
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !WORKSPACE_CREATE_FIELDS.includes(
        key as (typeof WORKSPACE_CREATE_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }
  return body;
}

export function createWorkspaceUpdateCommand(
  body: unknown,
): WorkspaceUpdateCommand {
  const violations: FieldViolation[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new WorkspaceCommandValidationError(violations);
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 0) {
    add(
      violations,
      'body',
      'empty-update',
      'must contain at least one field to update',
    );
  }

  for (const key of keys) {
    if (!WORKSPACE_UPDATE_FIELDS.includes(key as never)) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  const command: {
    name?: string;
    baseCurrency?: string;
  } = {};

  if ('name' in record) {
    command.name = nameValue(record.name, 'name', violations);
  }
  if ('baseCurrency' in record) {
    command.baseCurrency = currencyValue(
      record.baseCurrency,
      'baseCurrency',
      violations,
    );
  }

  if (violations.length > 0) {
    throw new WorkspaceCommandValidationError(
      violations.sort(
        (left, right) =>
          left.field.localeCompare(right.field) ||
          left.message.localeCompare(right.message),
      ),
    );
  }

  return Object.freeze(command);
}
