import { describe, expect, it } from 'vitest';

import {
  createProfileUpdateCommand,
  ProfileUpdateValidationError,
} from '../../src/identity/profile-update-command.js';

describe('createProfileUpdateCommand', () => {
  it('accepts a single-field update and returns only that field in a frozen command', () => {
    const singleFields = [
      [{ displayName: '  Ada Lovelace  ' }, { displayName: 'Ada Lovelace' }],
      [{ locale: 'es-co' }, { locale: 'es-CO' }],
      [{ timezone: 'america/bogota' }, { timezone: 'America/Bogota' }],
      [{ defaultCurrency: 'usd' }, { defaultCurrency: 'USD' }],
      [{ privacyModeEnabled: true }, { privacyModeEnabled: true }],
      [{ privacyModeEnabled: false }, { privacyModeEnabled: false }],
    ] as const;

    for (const [input, expected] of singleFields) {
      const command = createProfileUpdateCommand(input);
      expect(command).toEqual(expected);
      expect(Object.isFrozen(command)).toBe(true);
      expect(Object.keys(command)).toEqual(Object.keys(expected));
    }
  });

  it('rejects an empty object {} with an empty-update violation', () => {
    expectViolation(
      () => createProfileUpdateCommand({}),
      (violations) => {
        expect(violations).toHaveLength(1);
        expect(violations[0].code).toBe('empty-update');
      },
    );
  });

  it('rejects unknown properties and names the disallowed property in the violation', () => {
    expectViolation(
      () =>
        createProfileUpdateCommand({
          unknownField: 'test',
          displayName: 'Ada',
        }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'unknownField',
            code: 'not-allowed',
          }),
        );
      },
    );
  });

  it('enforces displayName boundaries: 1 and 120 accepted, 121 rejected', () => {
    const minCommand = createProfileUpdateCommand({ displayName: 'a' });
    expect(minCommand.displayName).toBe('a');

    const maxCommand = createProfileUpdateCommand({
      displayName: 'a'.repeat(120),
    });
    expect(maxCommand.displayName).toBe('a'.repeat(120));

    expectViolation(
      () => createProfileUpdateCommand({ displayName: 'a'.repeat(121) }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'displayName',
            code: 'max-length',
          }),
        );
      },
    );

    expectViolation(
      () => createProfileUpdateCommand({ displayName: '   ' }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'displayName',
            code: 'required',
          }),
        );
      },
    );

    // Reject NUL
    expectViolation(
      () => createProfileUpdateCommand({ displayName: 'Acme\0Corp' }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'displayName',
            code: 'invalid-characters',
          }),
        );
      },
    );

    // Unicode code points vs UTF-16 code units
    const exact120CodePoints = '\u{1F600}' + 'a'.repeat(119);
    expect(
      createProfileUpdateCommand({ displayName: exact120CodePoints })
        .displayName,
    ).toBe(exact120CodePoints);

    const exact121CodePoints = '\u{1F600}' + 'a'.repeat(120);
    expectViolation(
      () =>
        createProfileUpdateCommand({ displayName: exact121CodePoints }),
      (violations) => {
        expect(violations).toContainEqual(
          expect.objectContaining({
            field: 'displayName',
            code: 'max-length',
          }),
        );
      },
    );
  });

  it('accepts valid currency in lowercase and normalizes it to uppercase', () => {
    const command = createProfileUpdateCommand({ defaultCurrency: 'usd' });
    expect(command.defaultCurrency).toBe('USD');
  });

  it('rejects inactive or bogus currency', () => {
    for (const bogus of ['XXZ', 'XXX', 'invalid', '123']) {
      expectViolation(
        () => createProfileUpdateCommand({ defaultCurrency: bogus }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'defaultCurrency',
              code: 'invalid-currency',
            }),
          );
        },
      );
    }
  });

  it('rejects a bogus timezone', () => {
    for (const bogus of ['Mars/Olympus', 'Invalid/Timezone', 'UTC+99']) {
      expectViolation(
        () => createProfileUpdateCommand({ timezone: bogus }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'timezone',
              code: 'invalid-timezone',
            }),
          );
        },
      );
    }
  });

  it('rejects privacyModeEnabled when passed as a string or non-boolean', () => {
    for (const invalid of ['true', 'false', 1, 0, null, {}]) {
      expectViolation(
        () => createProfileUpdateCommand({ privacyModeEnabled: invalid }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'privacyModeEnabled',
              code: 'invalid-type',
            }),
          );
        },
      );
    }
  });

  it('rejects non-object bodies (null, [], and text) without throwing a TypeError', () => {
    const nonObjects = [null, undefined, [], [1, 2], 'text', 123, true];

    for (const body of nonObjects) {
      expectViolation(
        () => createProfileUpdateCommand(body),
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

  it('collects multiple simultaneous violations in one error rather than throwing on the first', () => {
    expectViolation(
      () =>
        createProfileUpdateCommand({
          displayName: 'a'.repeat(121),
          timezone: 'Mars/Olympus',
          defaultCurrency: 'XXZ',
          privacyModeEnabled: 'true',
          extraProperty: 'forbidden',
        }),
      (violations) => {
        expect(violations.length).toBe(5);
        const fields = violations.map((v) => v.field);
        expect(fields).toContain('displayName');
        expect(fields).toContain('timezone');
        expect(fields).toContain('defaultCurrency');
        expect(fields).toContain('privacyModeEnabled');
        expect(fields).toContain('extraProperty');
      },
    );
  });

  it('sorts violations deterministically by field then message', () => {
    const getViolations = (input: unknown) => {
      try {
        createProfileUpdateCommand(input);
      } catch (error) {
        if (error instanceof ProfileUpdateValidationError) {
          return error.violations;
        }
      }
      throw new Error('expected ProfileUpdateValidationError');
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
  expect(action).toThrow(ProfileUpdateValidationError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileUpdateValidationError);
    assertViolations((error as ProfileUpdateValidationError).violations);
  }
}
