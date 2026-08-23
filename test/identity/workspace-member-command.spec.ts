import { describe, expect, it } from 'vitest';

import {
  createWorkspaceMemberUpdateCommand,
  WorkspaceMemberCommandValidationError,
} from '../../src/identity/workspace-member-command.js';

describe('createWorkspaceMemberUpdateCommand', () => {
  it('accepts each valid role and returns a frozen command', () => {
    for (const role of [
      'owner',
      'administrator',
      'editor',
      'viewer',
    ] as const) {
      const command = createWorkspaceMemberUpdateCommand({ role });
      expect(command).toEqual({ role });
      expect(Object.isFrozen(command)).toBe(true);
      expect(Object.keys(command)).toEqual(['role']);
    }
  });

  it('rejects non-object body inputs (null, array, string, number, boolean)', () => {
    for (const input of [null, undefined, [], [1, 2], 'string', 123, true]) {
      expectViolation(
        () => createWorkspaceMemberUpdateCommand(input),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'body',
              code: 'invalid-type',
            }),
          );
        },
      );
    }
  });

  it('rejects an empty object {} with role required', () => {
    expectViolation(
      () => createWorkspaceMemberUpdateCommand({}),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'role',
            code: 'required',
          }),
        );
      },
    );
  });

  it('rejects non-string role values', () => {
    for (const badRole of [42, null, true, [], {}]) {
      expectViolation(
        () => createWorkspaceMemberUpdateCommand({ role: badRole }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'role',
              code: 'required',
            }),
          );
        },
      );
    }
  });

  it('rejects empty or whitespace-only role', () => {
    for (const badRole of ['', '   ']) {
      expectViolation(
        () => createWorkspaceMemberUpdateCommand({ role: badRole }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'role',
              code: 'required',
            }),
          );
        },
      );
    }
  });

  it('rejects unsupported roles including non-canonical casing', () => {
    for (const badRole of [
      'admin',
      'OWNER',
      'Owner',
      'member',
      'guest',
      'root',
    ]) {
      expectViolation(
        () => createWorkspaceMemberUpdateCommand({ role: badRole }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'role',
              code: 'unsupported',
              message: 'role must be owner, administrator, editor or viewer',
            }),
          );
        },
      );
    }
  });

  it('rejects role containing NUL character', () => {
    expectViolation(
      () => createWorkspaceMemberUpdateCommand({ role: 'editor\0' }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'role',
            code: 'invalid-characters',
          }),
        );
      },
    );
  });

  it('rejects unknown properties (additionalProperties: false)', () => {
    for (const field of [
      'status',
      'id',
      'userId',
      'displayName',
      'email',
      'version',
      'extraField',
    ]) {
      expectViolation(
        () =>
          createWorkspaceMemberUpdateCommand({
            role: 'editor',
            [field]: 'value',
          }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field,
              code: 'not-allowed',
            }),
          );
        },
      );
    }
  });

  it('collects multiple simultaneous violations in one error and sorts them deterministically', () => {
    expectViolation(
      () =>
        createWorkspaceMemberUpdateCommand({
          role: 'OWNER',
          status: 'suspended',
          extra: 'bad',
        }),
      (violations) => {
        expect(violations.length).toBe(3);
        const fields = violations.map((v) => v.field);
        expect(fields).toEqual(['extra', 'role', 'status']);
      },
    );
  });
});

function expectViolation(
  action: () => unknown,
  assertViolations: (
    violations: readonly { field: string; code: string; message: string }[],
  ) => void,
): void {
  expect(action).toThrow(WorkspaceMemberCommandValidationError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceMemberCommandValidationError);
    assertViolations(
      (error as WorkspaceMemberCommandValidationError).violations,
    );
  }
}
