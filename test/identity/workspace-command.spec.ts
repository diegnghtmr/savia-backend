import { describe, expect, it } from 'vitest';

import {
  createWorkspaceUpdateCommand,
  WorkspaceCommandValidationError,
} from '../../src/identity/workspace-command.js';

describe('createWorkspaceUpdateCommand', () => {
  it('accepts a single-field name update and returns frozen command', () => {
    const command = createWorkspaceUpdateCommand({ name: '  Acme Corp  ' });
    expect(command).toEqual({ name: 'Acme Corp' });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.keys(command)).toEqual(['name']);
  });

  it('accepts a single-field baseCurrency update and normalizes to uppercase', () => {
    const command = createWorkspaceUpdateCommand({ baseCurrency: 'usd' });
    expect(command).toEqual({ baseCurrency: 'USD' });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.keys(command)).toEqual(['baseCurrency']);
  });

  it('accepts both name and baseCurrency', () => {
    const command = createWorkspaceUpdateCommand({
      name: 'Acme Corp',
      baseCurrency: 'eur',
    });
    expect(command).toEqual({ name: 'Acme Corp', baseCurrency: 'EUR' });
    expect(Object.isFrozen(command)).toBe(true);
  });

  it('rejects an empty object {} with an empty-update violation', () => {
    expectViolation(
      () => createWorkspaceUpdateCommand({}),
      (violations) => {
        expect(violations).toHaveLength(1);
        expect(violations[0].code).toBe('empty-update');
      },
    );
  });

  it('rejects unknown properties including immutable fields (kind, id, version, createdBy)', () => {
    for (const field of ['kind', 'id', 'version', 'createdBy', 'extraField']) {
      expectViolation(
        () => createWorkspaceUpdateCommand({ [field]: 'value', name: 'Acme' }),
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

  it('enforces name boundaries: 1 and 120 accepted, 121 and empty rejected', () => {
    const minCommand = createWorkspaceUpdateCommand({ name: 'a' });
    expect(minCommand.name).toBe('a');

    const maxCommand = createWorkspaceUpdateCommand({ name: 'a'.repeat(120) });
    expect(maxCommand.name).toBe('a'.repeat(120));

    expectViolation(
      () => createWorkspaceUpdateCommand({ name: 'a'.repeat(121) }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'max-length',
          }),
        );
      },
    );

    expectViolation(
      () => createWorkspaceUpdateCommand({ name: '   ' }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'required',
          }),
        );
      },
    );
  });

  it('rejects invalid, malformed, or inactive baseCurrency', () => {
    for (const bogus of ['USDX', 'US', 'usd1', 'XXZ', 'XXX', '123', '']) {
      expectViolation(
        () => createWorkspaceUpdateCommand({ baseCurrency: bogus }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'baseCurrency',
            }),
          );
        },
      );
    }
  });

  it('rejects non-object body inputs (null, array, string, number, boolean)', () => {
    for (const input of [null, undefined, [], 'string', 123, true]) {
      expectViolation(
        () => createWorkspaceUpdateCommand(input),
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

  it('collects multiple simultaneous violations in one error', () => {
    expectViolation(
      () =>
        createWorkspaceUpdateCommand({
          name: 'a'.repeat(121),
          baseCurrency: 'USDX',
          kind: 'personal',
          extra: 'bad',
        }),
      (violations) => {
        expect(violations.length).toBe(4);
        const fields = violations.map((v) => v.field);
        expect(fields).toContain('name');
        expect(fields).toContain('baseCurrency');
        expect(fields).toContain('kind');
        expect(fields).toContain('extra');
      },
    );
  });

  it('sorts violations deterministically by field then message', () => {
    const getViolations = (input: unknown) => {
      try {
        createWorkspaceUpdateCommand(input);
      } catch (error) {
        if (error instanceof WorkspaceCommandValidationError) {
          return error.violations;
        }
      }
      throw new Error('expected WorkspaceCommandValidationError');
    };

    const violations1 = getViolations({ z: 1, a: 1 });
    const violations2 = getViolations({ a: 1, z: 1 });
    expect(violations1).toEqual(violations2);
  });
});

function expectViolation(
  action: () => unknown,
  assertViolations: (
    violations: readonly { field: string; code: string; message: string }[],
  ) => void,
): void {
  expect(action).toThrow(WorkspaceCommandValidationError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceCommandValidationError);
    assertViolations((error as WorkspaceCommandValidationError).violations);
  }
}
