import { add, stringValue, type FieldViolation } from './bootstrap-command.js';
import type { WorkspaceRole } from './workspace.port.js';

const ALLOWED_ROLES = ['owner', 'administrator', 'editor', 'viewer'] as const;
const WORKSPACE_MEMBER_UPDATE_FIELDS = ['role'] as const;

export interface WorkspaceMemberUpdateCommand {
  readonly role: WorkspaceRole;
}

export class WorkspaceMemberCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Workspace member command validation failed.');
  }
}

export function createWorkspaceMemberUpdateCommand(
  input: unknown,
): WorkspaceMemberUpdateCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new WorkspaceMemberCommandValidationError(violations);
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!WORKSPACE_MEMBER_UPDATE_FIELDS.includes(key as never)) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let role: WorkspaceRole | undefined;

  if (!('role' in record)) {
    add(violations, 'role', 'required', 'must be a non-empty string');
  } else {
    const rawRole = stringValue(record.role, 'role', violations);
    if (rawRole) {
      if (!ALLOWED_ROLES.includes(rawRole as (typeof ALLOWED_ROLES)[number])) {
        add(
          violations,
          'role',
          'unsupported',
          'role must be owner, administrator, editor or viewer',
        );
      } else {
        role = rawRole as WorkspaceRole;
      }
    }
  }

  if (violations.length > 0) {
    throw new WorkspaceMemberCommandValidationError(
      violations.sort(
        (left, right) =>
          left.field.localeCompare(right.field) ||
          left.message.localeCompare(right.message),
      ),
    );
  }

  return Object.freeze({
    role: role!,
  });
}
