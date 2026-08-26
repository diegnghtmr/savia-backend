import {
  add,
  sortViolations,
  stringValue,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { WorkspaceRole } from './workspace.port.js';

// prettier-ignore
const EMAIL_PATTERN = /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;
const ALLOWED_ROLES = ['owner', 'administrator', 'editor', 'viewer'] as const;
const WORKSPACE_INVITATION_CREATE_FIELDS = ['email', 'role'] as const;

export interface CreateWorkspaceInvitationCommand {
  readonly email: string;
  readonly role: WorkspaceRole;
}

export class WorkspaceInvitationCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Workspace invitation command validation failed.');
  }
}

export function createWorkspaceInvitationCommand(
  input: unknown,
): CreateWorkspaceInvitationCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new WorkspaceInvitationCommandValidationError(violations);
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (
      !WORKSPACE_INVITATION_CREATE_FIELDS.includes(
        key as (typeof WORKSPACE_INVITATION_CREATE_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let email: string | undefined;
  let role: WorkspaceRole | undefined;

  if (!('email' in record)) {
    add(violations, 'email', 'required', 'must be a non-empty string');
  } else {
    const rawEmail = stringValue(record.email, 'email', violations);
    if (rawEmail) {
      if (
        rawEmail.length < 3 ||
        rawEmail.length > 320 ||
        rawEmail.indexOf('@') > 64 ||
        !EMAIL_PATTERN.test(rawEmail)
      ) {
        add(
          violations,
          'email',
          'invalid-email',
          'must be a valid email address',
        );
      } else {
        email = rawEmail;
      }
    }
  }

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
    throw new WorkspaceInvitationCommandValidationError(
      sortViolations(violations),
    );
  }

  return Object.freeze({
    email: email!,
    role: role!,
  });
}
