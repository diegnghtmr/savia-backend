import {
  add,
  currencyValue,
  nameValue,
  type FieldViolation,
} from './bootstrap-command.js';

// prettier-ignore
const WORKSPACE_UPDATE_FIELDS = ['name', 'baseCurrency'] as const;

export interface WorkspaceUpdateCommand {
  readonly name?: string;
  readonly baseCurrency?: string;
}

export class WorkspaceCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Workspace update command validation failed.');
  }
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
