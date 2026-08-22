import { describe, expect, it } from 'vitest';

import {
  createWorkspaceCreateCommand,
  createWorkspaceUpdateCommand,
  WorkspaceCommandValidationError,
} from '../../src/identity/workspace-command.js';

describe('createWorkspaceCreateCommand', () => {
  it('accepts valid input with explicit family kind and returns frozen command', () => {
    const command = createWorkspaceCreateCommand({
      name: '  Acme Family  ',
      kind: 'family',
      baseCurrency: 'usd',
    });
    expect(command).toEqual({
      name: 'Acme Family',
      kind: 'family',
      baseCurrency: 'USD',
    });
    expect(Object.isFrozen(command)).toBe(true);
  });

  it('accepts valid input with explicit shared kind', () => {
    const command = createWorkspaceCreateCommand({
      name: 'Acme Shared',
      kind: 'shared',
      baseCurrency: 'cop',
    });
    expect(command).toEqual({
      name: 'Acme Shared',
      kind: 'shared',
      baseCurrency: 'COP',
    });
    expect(Object.isFrozen(command)).toBe(true);
  });

  it("defaults kind to 'family' when kind is undefined", () => {
    const command = createWorkspaceCreateCommand({
      name: 'Default Family Workspace',
      baseCurrency: 'eur',
    });
    expect(command).toEqual({
      name: 'Default Family Workspace',
      kind: 'family',
      baseCurrency: 'EUR',
    });
    expect(Object.isFrozen(command)).toBe(true);
  });

  it("rejects kind: 'personal' with a validation error", () => {
    expectViolation(
      () =>
        createWorkspaceCreateCommand({
          name: 'My Workspace',
          kind: 'personal',
          baseCurrency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'kind',
          }),
        );
      },
    );
  });

  it('rejects invalid or unsupported kind values', () => {
    for (const badKind of ['other', 'private', 'admin', '', 123, false, null]) {
      expectViolation(
        () =>
          createWorkspaceCreateCommand({
            name: 'My Workspace',
            kind: badKind,
            baseCurrency: 'USD',
          }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'kind',
            }),
          );
        },
      );
    }
  });

  it('rejects unknown properties (additionalProperties: false)', () => {
    for (const field of ['id', 'version', 'createdBy', 'extraField', 'role']) {
      expectViolation(
        () =>
          createWorkspaceCreateCommand({
            name: 'Acme',
            baseCurrency: 'USD',
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

  it('requires name: rejects missing, empty, or whitespace-only name', () => {
    for (const badName of [undefined, '', '   ']) {
      expectViolation(
        () =>
          createWorkspaceCreateCommand({
            name: badName,
            baseCurrency: 'USD',
          }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'name',
              code: 'required',
            }),
          );
        },
      );
    }
  });

  it('enforces name length boundaries (1..120 code points)', () => {
    const minCommand = createWorkspaceCreateCommand({
      name: 'a',
      baseCurrency: 'USD',
    });
    expect(minCommand.name).toBe('a');

    const maxCommand = createWorkspaceCreateCommand({
      name: 'a'.repeat(120),
      baseCurrency: 'USD',
    });
    expect(maxCommand.name).toBe('a'.repeat(120));

    expectViolation(
      () =>
        createWorkspaceCreateCommand({
          name: 'a'.repeat(121),
          baseCurrency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'max-length',
          }),
        );
      },
    );
  });

  it('requires baseCurrency: rejects missing, invalid, malformed, or inactive currency', () => {
    for (const badCurrency of [
      undefined,
      '',
      '   ',
      'USDX',
      'US',
      'usd1',
      'XXZ',
      'XXX',
      '123',
    ]) {
      expectViolation(
        () =>
          createWorkspaceCreateCommand({
            name: 'Acme',
            baseCurrency: badCurrency,
          }),
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
        () => createWorkspaceCreateCommand(input),
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

  it('collects multiple simultaneous violations in one error and sorts them deterministically', () => {
    expectViolation(
      () =>
        createWorkspaceCreateCommand({
          name: 'a'.repeat(121),
          kind: 'personal',
          baseCurrency: 'USDX',
          extra: 'bad',
        }),
      (violations) => {
        expect(violations.length).toBe(4);
        const fields = violations.map((v) => v.field);
        expect(fields).toEqual(['baseCurrency', 'extra', 'kind', 'name']);
      },
    );
  });
});

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

    // Reject NUL
    expectViolation(
      () => createWorkspaceUpdateCommand({ name: 'Acme\0Corp' }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'invalid-characters',
          }),
        );
      },
    );

    // Unicode code points vs UTF-16 code units
    const exact120CodePoints = '\u{1F600}' + 'a'.repeat(119);
    expect(
      createWorkspaceUpdateCommand({ name: exact120CodePoints }).name,
    ).toBe(exact120CodePoints);

    const exact121CodePoints = '\u{1F600}' + 'a'.repeat(120);
    expectViolation(
      () => createWorkspaceUpdateCommand({ name: exact121CodePoints }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'name',
            code: 'max-length',
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
