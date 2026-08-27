import { describe, expect, it } from 'vitest';

import {
  createUpdateAccountCommand,
  AccountCommandValidationError,
  type UpdateAccountCommand,
} from '../../src/accounts/account-command.js';
import type { FieldViolation } from '../../src/platform/problem-details.js';

function expectViolations(
  factory: () => unknown,
  assert: (violations: readonly FieldViolation[]) => void,
): void {
  try {
    factory();
    expect.fail('Expected AccountCommandValidationError to be thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(AccountCommandValidationError);
    if (error instanceof AccountCommandValidationError) {
      assert(error.violations);
    }
  }
}

describe('createUpdateAccountCommand', () => {
  it('accepts valid single-field update: name', () => {
    const command = createUpdateAccountCommand({
      name: '  Updated Checking Account  ',
    });

    expect(command).toEqual({
      name: 'Updated Checking Account',
    } satisfies UpdateAccountCommand);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it('accepts valid single-field update: includeInNetWorth', () => {
    const command = createUpdateAccountCommand({
      includeInNetWorth: false,
    });

    expect(command).toEqual({
      includeInNetWorth: false,
    } satisfies UpdateAccountCommand);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it.each(['active', 'archived'] as const)(
    'accepts valid status update: %s',
    (status) => {
      const command = createUpdateAccountCommand({ status });
      expect(command).toEqual({ status } satisfies UpdateAccountCommand);
      expect(Object.isFrozen(command)).toBe(true);
    },
  );

  it('refuses status: closed with unsupported violation (closing is closeAccount job)', () => {
    expectViolations(
      () => createUpdateAccountCommand({ status: 'closed' }),
      (violations) => {
        expect(violations).toEqual([
          {
            field: 'status',
            code: 'unsupported',
            message: 'status must be one of active, archived',
          },
        ]);
      },
    );
  });

  it.each(['institution', 'maskedNumber', 'description'])(
    'accepts explicit null for %s and maps to null (clears field)',
    (field) => {
      const command = createUpdateAccountCommand({
        [field]: null,
      });

      expect(command).toEqual({
        [field]: null,
      });
      expect(Object.isFrozen(command)).toBe(true);
    },
  );

  it('accepts explicit null clearing multiple fields simultaneously', () => {
    const command = createUpdateAccountCommand({
      name: 'Clean Account',
      institution: null,
      maskedNumber: null,
      description: null,
    });

    expect(command).toEqual({
      name: 'Clean Account',
      institution: null,
      maskedNumber: null,
      description: null,
    } satisfies UpdateAccountCommand);
  });

  it('accepts all valid updatable fields provided together', () => {
    const command = createUpdateAccountCommand({
      name: 'New Name',
      institution: 'New Bank',
      maskedNumber: '**** 9876',
      description: 'Updated description',
      includeInNetWorth: true,
      status: 'archived',
    });

    expect(command).toEqual({
      name: 'New Name',
      institution: 'New Bank',
      maskedNumber: '**** 9876',
      description: 'Updated description',
      includeInNetWorth: true,
      status: 'archived',
    } satisfies UpdateAccountCommand);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it.each([null, undefined, 123, 'string', true, false, []])(
    'refuses non-object body %s with invalid-type violation',
    (badBody) => {
      expectViolations(
        () => createUpdateAccountCommand(badBody),
        (violations) => {
          expect(violations).toEqual([
            {
              field: 'body',
              code: 'invalid-type',
              message: 'must be an object',
            },
          ]);
        },
      );
    },
  );

  it('refuses empty object {} with empty-update violation (minProperties: 1)', () => {
    expectViolations(
      () => createUpdateAccountCommand({}),
      (violations) => {
        expect(violations).toEqual([
          {
            field: 'body',
            code: 'empty-update',
            message: 'must contain at least one field to update',
          },
        ]);
      },
    );
  });

  it.each([
    'type',
    'currency',
    'openingBalance',
    'openingBalanceDate',
    'colorToken',
    'icon',
    'createdAt',
    'updatedAt',
    'version',
    'extraField',
  ])('refuses not-allowed field %s (additionalProperties: false)', (field) => {
    expectViolations(
      () =>
        createUpdateAccountCommand({
          name: 'Valid Name',
          [field]: 'any-value',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field,
          code: 'not-allowed',
          message: 'is not allowed',
        });
      },
    );
  });

  it.each(['', '   ', '\t\n'])(
    'refuses empty/whitespace name %j with required violation',
    (badName) => {
      expectViolations(
        () => createUpdateAccountCommand({ name: badName }),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'name',
            code: 'required',
            message: 'must be a non-empty string',
          });
        },
      );
    },
  );

  it('refuses name exceeding 120 characters with max-length violation', () => {
    const overlongName = 'a'.repeat(121);
    expectViolations(
      () => createUpdateAccountCommand({ name: overlongName }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'name',
          code: 'max-length',
          message: 'must be at most 120 characters',
        });
      },
    );
  });

  it('refuses name with null character U+0000 with invalid-characters violation', () => {
    expectViolations(
      () => createUpdateAccountCommand({ name: 'Account\0Name' }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'name',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        });
      },
    );
  });

  it('refuses non-boolean includeInNetWorth with invalid-type violation', () => {
    expectViolations(
      () => createUpdateAccountCommand({ includeInNetWorth: 'true' }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'includeInNetWorth',
          code: 'invalid-type',
          message: 'must be a boolean',
        });
      },
    );
  });

  it('refuses institution exceeding 120 characters with max-length violation', () => {
    expectViolations(
      () => createUpdateAccountCommand({ institution: 'a'.repeat(121) }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'institution',
          code: 'max-length',
          message: 'must be at most 120 characters',
        });
      },
    );
  });

  it('refuses maskedNumber exceeding 32 characters with max-length violation', () => {
    expectViolations(
      () => createUpdateAccountCommand({ maskedNumber: 'a'.repeat(33) }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'maskedNumber',
          code: 'max-length',
          message: 'must be at most 32 characters',
        });
      },
    );
  });

  it('refuses description exceeding 500 characters with max-length violation', () => {
    expectViolations(
      () => createUpdateAccountCommand({ description: 'a'.repeat(501) }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'description',
          code: 'max-length',
          message: 'must be at most 500 characters',
        });
      },
    );
  });

  it('sorts multiple violations deterministically by field then message', () => {
    expectViolations(
      () =>
        createUpdateAccountCommand({
          name: '',
          status: 'unknown',
          includeInNetWorth: 123,
        }),
      (violations) => {
        expect(violations).toEqual([
          {
            field: 'includeInNetWorth',
            code: 'invalid-type',
            message: 'must be a boolean',
          },
          {
            field: 'name',
            code: 'required',
            message: 'must be a non-empty string',
          },
          {
            field: 'status',
            code: 'unsupported',
            message: 'status must be one of active, archived',
          },
        ]);
      },
    );
  });
});
