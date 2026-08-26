import { describe, expect, it } from 'vitest';

import {
  createAccountCommand,
  AccountCommandValidationError,
  type CreateAccountCommand,
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

describe('createAccountCommand', () => {
  it('accepts valid minimal input and returns frozen command with defaults', () => {
    const command = createAccountCommand({
      name: '  Checking Account  ',
      type: 'checking',
      currency: 'usd',
    });

    expect(command).toEqual({
      name: 'Checking Account',
      type: 'checking',
      currency: 'USD',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    } satisfies CreateAccountCommand);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it.each(['institution', 'maskedNumber', 'description'])(
    'refuses an explicit null for %s: CreateAccountRequest declares it string, not nullable',
    (field) => {
      // UpdateAccountRequest declares these same three as `type: [string, 'null']`
      // while CreateAccountRequest declares plain `type: string`. The asymmetry is
      // deliberate, so an explicit null on create is a body the authority forbids
      // and must not be silently treated as "absent".
      let thrown: unknown;
      try {
        createAccountCommand({
          name: 'Checking Account',
          type: 'checking',
          currency: 'USD',
          [field]: null,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AccountCommandValidationError);
      const violations = (thrown as AccountCommandValidationError)
        .violations as readonly FieldViolation[];
      expect(violations).toContainEqual({
        field,
        code: 'invalid-type',
        message: expect.any(String) as unknown as string,
      });
    },
  );

  it('accepts valid input with all optional fields provided', () => {
    const command = createAccountCommand({
      name: 'Primary Savings',
      type: 'savings',
      currency: 'COP',
      institution: 'Bancolombia',
      maskedNumber: '***1234',
      description: 'Emergency funds for 6 months',
      includeInNetWorth: false,
    });

    expect(command).toEqual({
      name: 'Primary Savings',
      type: 'savings',
      currency: 'COP',
      institution: 'Bancolombia',
      maskedNumber: '***1234',
      description: 'Emergency funds for 6 months',
      includeInNetWorth: false,
    } satisfies CreateAccountCommand);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it('admits all nine declared AccountType enum values', () => {
    const types = [
      'cash',
      'savings',
      'checking',
      'digital_wallet',
      'credit_card',
      'loan',
      'investment_manual',
      'receivable',
      'generic',
    ] as const;

    for (const type of types) {
      const command = createAccountCommand({
        name: `Account ${type}`,
        type,
        currency: 'EUR',
      });
      expect(command.type).toBe(type);
    }
  });

  it('rejects non-object body inputs', () => {
    for (const badBody of [null, undefined, 'string', 123, true, []]) {
      expectViolations(
        () => createAccountCommand(badBody),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'body',
            code: 'invalid-type',
            message: 'must be an object',
          });
        },
      );
    }
  });

  it('rejects unknown properties (additionalProperties: false)', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Main',
          type: 'checking',
          currency: 'USD',
          extraField: 'unexpected',
          anotherUnknown: 42,
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'extraField',
          code: 'not-allowed',
          message: 'is not allowed',
        });
        expect(violations).toContainEqual({
          field: 'anotherUnknown',
          code: 'not-allowed',
          message: 'is not allowed',
        });
      },
    );
  });

  it('refuses openingBalance with 422 field violation (not supported in slice 6a)', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Account with balance',
          type: 'checking',
          currency: 'USD',
          openingBalance: {
            amountMinor: '10000',
            currency: 'USD',
          },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalance',
          code: 'unsupported',
          message: 'opening balance is not supported in this slice',
        });
      },
    );
  });

  it('refuses openingBalanceDate with 422 field violation (not supported in slice 6a)', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Account with balance date',
          type: 'checking',
          currency: 'USD',
          openingBalanceDate: '2026-08-25',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalanceDate',
          code: 'unsupported',
          message: 'opening balance date is not supported in this slice',
        });
      },
    );
  });

  it('rejects missing, empty, invalid-character or overly long names', () => {
    expectViolations(
      () =>
        createAccountCommand({
          type: 'checking',
          currency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'name',
          code: 'required',
          message: 'must be a non-empty string',
        });
      },
    );

    expectViolations(
      () =>
        createAccountCommand({
          name: '   ',
          type: 'checking',
          currency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'name',
          code: 'required',
          message: 'must be a non-empty string',
        });
      },
    );

    expectViolations(
      () =>
        createAccountCommand({
          name: 'bad\0name',
          type: 'checking',
          currency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'name',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        });
      },
    );

    expectViolations(
      () =>
        createAccountCommand({
          name: 'a'.repeat(121),
          type: 'checking',
          currency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'name',
          code: 'max-length',
          message: 'must be at most 120 characters',
        });
      },
    );
  });

  it('rejects missing or unsupported account types', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'My Account',
          currency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'type',
          code: 'required',
          message: 'must be a non-empty string',
        });
      },
    );

    expectViolations(
      () =>
        createAccountCommand({
          name: 'My Account',
          type: 'crypto_wallet',
          currency: 'USD',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'type',
          code: 'unsupported',
          message:
            'type must be one of cash, savings, checking, digital_wallet, credit_card, loan, investment_manual, receivable, generic',
        });
      },
    );
  });

  it('rejects missing or invalid ISO 4217 currencies', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'My Account',
          type: 'checking',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'currency',
          code: 'required',
          message: 'must be a non-empty string',
        });
      },
    );

    expectViolations(
      () =>
        createAccountCommand({
          name: 'My Account',
          type: 'checking',
          currency: 'XYZ',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'currency',
          code: 'invalid-currency',
          message: 'must be an active ISO 4217 currency',
        });
      },
    );
  });

  it('rejects invalid institution, maskedNumber, description, and includeInNetWorth', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'My Account',
          type: 'checking',
          currency: 'USD',
          institution: 123,
          maskedNumber: 456,
          description: false,
          includeInNetWorth: 'yes',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'institution',
          code: 'invalid-type',
          message: 'must be a string',
        });
        expect(violations).toContainEqual({
          field: 'maskedNumber',
          code: 'invalid-type',
          message: 'must be a string',
        });
        expect(violations).toContainEqual({
          field: 'description',
          code: 'invalid-type',
          message: 'must be a string',
        });
        expect(violations).toContainEqual({
          field: 'includeInNetWorth',
          code: 'invalid-type',
          message: 'must be a boolean',
        });
      },
    );

    expectViolations(
      () =>
        createAccountCommand({
          name: 'My Account',
          type: 'checking',
          currency: 'USD',
          institution: 'i'.repeat(121),
          maskedNumber: 'm'.repeat(33),
          description: 'd'.repeat(501),
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'institution',
          code: 'max-length',
          message: 'must be at most 120 characters',
        });
        expect(violations).toContainEqual({
          field: 'maskedNumber',
          code: 'max-length',
          message: 'must be at most 32 characters',
        });
        expect(violations).toContainEqual({
          field: 'description',
          code: 'max-length',
          message: 'must be at most 500 characters',
        });
      },
    );
  });

  it('sorts violations alphabetically by field and message', () => {
    expectViolations(
      () =>
        createAccountCommand({
          extraB: 1,
          extraA: 2,
        }),
      (violations) => {
        const fields = violations.map((v) => v.field);
        const sorted = [...fields].sort();
        expect(fields).toEqual(sorted);
      },
    );
  });
});
