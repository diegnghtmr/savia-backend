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

  it('accepts valid input with openingBalance and optional openingBalanceDate', () => {
    const command = createAccountCommand({
      name: 'Checking Account',
      type: 'checking',
      currency: 'USD',
      openingBalance: {
        amountMinor: '10000',
        currency: 'USD',
      },
      openingBalanceDate: '2026-08-25',
    });

    expect(command).toEqual({
      name: 'Checking Account',
      type: 'checking',
      currency: 'USD',
      openingBalance: {
        amountMinor: '10000',
        currency: 'USD',
      },
      openingBalanceDate: '2026-08-25',
      institution: null,
      maskedNumber: null,
      description: null,
      includeInNetWorth: true,
    } satisfies CreateAccountCommand);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.openingBalance)).toBe(true);
  });

  it('accepts openingBalance without openingBalanceDate', () => {
    const command = createAccountCommand({
      name: 'Checking Account',
      type: 'checking',
      currency: 'USD',
      openingBalance: {
        amountMinor: '5000',
        currency: 'USD',
      },
    });

    expect(command.openingBalance).toEqual({
      amountMinor: '5000',
      currency: 'USD',
    });
    expect(command.openingBalanceDate).toBeNull();
  });

  it('rejects openingBalanceDate when openingBalance is absent', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Checking Account',
          type: 'checking',
          currency: 'USD',
          openingBalanceDate: '2026-08-25',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalanceDate',
          code: 'not-allowed',
          message: 'cannot be provided without openingBalance',
        });
      },
    );
  });

  it.each([null, '1000', 1000, true, []])(
    'rejects non-object openingBalance %s with invalid-type',
    (badBalance) => {
      expectViolations(
        () =>
          createAccountCommand({
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            openingBalance: badBalance,
          }),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'openingBalance',
            code: 'invalid-type',
            message: 'must be an object',
          });
        },
      );
    },
  );

  it('rejects unexpected properties on openingBalance (additionalProperties: false)', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Checking Account',
          type: 'checking',
          currency: 'USD',
          openingBalance: {
            amountMinor: '10000',
            currency: 'USD',
            extra: 'unexpected',
          },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalance.extra',
          code: 'not-allowed',
          message: 'is not allowed',
        });
      },
    );
  });

  it.each([undefined, null, 123, true, {}, []])(
    'rejects missing or non-string amountMinor %s',
    (badAmount) => {
      expectViolations(
        () =>
          createAccountCommand({
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            openingBalance: {
              amountMinor: badAmount,
              currency: 'USD',
            },
          }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'openingBalance.amountMinor',
            }),
          );
        },
      );
    },
  );

  it.each(['', '   ', '12.34', '1,000', 'abc', '++100', '--100', '100a'])(
    'rejects malformed amountMinor string %j',
    (badFormat) => {
      expectViolations(
        () =>
          createAccountCommand({
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            openingBalance: {
              amountMinor: badFormat,
              currency: 'USD',
            },
          }),
        (violations) => {
          expect(violations).toContainEqual(
            expect.objectContaining({
              field: 'openingBalance.amountMinor',
            }),
          );
        },
      );
    },
  );

  it('rejects out-of-range amountMinor with a 30-digit value and 64-bit boundaries', () => {
    const thirtyDigits = '999999999999999999999999999999';
    const negativeThirtyDigits = '-999999999999999999999999999999';
    const overMaxInt64 = '9223372036854775808';
    const underMinInt64 = '-9223372036854775809';

    for (const outOfRange of [
      thirtyDigits,
      negativeThirtyDigits,
      overMaxInt64,
      underMinInt64,
    ]) {
      expectViolations(
        () =>
          createAccountCommand({
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            openingBalance: {
              amountMinor: outOfRange,
              currency: 'USD',
            },
          }),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'openingBalance.amountMinor',
            code: 'invalid-range',
            message: 'must be within 64-bit signed integer range',
          });
        },
      );
    }
  });

  it('accepts exact 64-bit boundaries and values exceeding Number.MAX_SAFE_INTEGER (2^53 - 1)', () => {
    const aboveSafeInt = '9007199254740993'; // 2^53 + 1
    const maxInt64 = '9223372036854775807';
    const minInt64 = '-9223372036854775807';

    for (const validBig of [aboveSafeInt, maxInt64, minInt64, '-5000', '0']) {
      const cmd = createAccountCommand({
        name: 'Checking Account',
        type: 'checking',
        currency: 'USD',
        openingBalance: {
          amountMinor: validBig,
          currency: 'USD',
        },
      });
      expect(cmd.openingBalance?.amountMinor).toBe(validBig);
    }
  });

  it('rejects openingBalance currency that does not match account currency', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Checking Account',
          type: 'checking',
          currency: 'USD',
          openingBalance: {
            amountMinor: '10000',
            currency: 'EUR',
          },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalance.currency',
          code: 'currency-mismatch',
          message: 'opening balance currency must match account currency',
        });
      },
    );
  });

  it('rejects missing or invalid ISO 4217 currency in openingBalance', () => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Checking Account',
          type: 'checking',
          currency: 'USD',
          openingBalance: {
            amountMinor: '10000',
            currency: 'XYZ',
          },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalance.currency',
          code: 'invalid-currency',
          message: 'must be an active ISO 4217 currency',
        });
      },
    );
  });

  it.each([null, 123, true, {}, []])(
    'rejects non-string openingBalanceDate %s',
    (badDate) => {
      expectViolations(
        () =>
          createAccountCommand({
            name: 'Checking Account',
            type: 'checking',
            currency: 'USD',
            openingBalance: {
              amountMinor: '10000',
              currency: 'USD',
            },
            openingBalanceDate: badDate,
          }),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'openingBalanceDate',
            code: 'invalid-type',
            message: 'must be a string',
          });
        },
      );
    },
  );

  it.each([
    '2026-02-30', // Feb 30 does not exist
    '2025-02-29', // 2025 is not a leap year
    '2026-04-31', // April has 30 days
    '2026-13-01', // Month 13 does not exist
    '2026-00-10', // Month 0 does not exist
    '2026-01-32', // Day 32 does not exist
    '2026/08/25', // Slash format
    '25-08-2026', // DD-MM-YYYY format
    '2026-8-25', // Non-padded month
    'invalid-date',
  ])('rejects invalid calendar date %j for openingBalanceDate', (badDate) => {
    expectViolations(
      () =>
        createAccountCommand({
          name: 'Checking Account',
          type: 'checking',
          currency: 'USD',
          openingBalance: {
            amountMinor: '10000',
            currency: 'USD',
          },
          openingBalanceDate: badDate,
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'openingBalanceDate',
          code: 'invalid-date',
          message: 'must be a valid calendar date in YYYY-MM-DD format',
        });
      },
    );
  });

  it.each(['2024-02-29', '2026-01-31', '2026-12-31', '2026-08-25'])(
    'accepts valid calendar date %j for openingBalanceDate',
    (validDate) => {
      const cmd = createAccountCommand({
        name: 'Checking Account',
        type: 'checking',
        currency: 'USD',
        openingBalance: {
          amountMinor: '10000',
          currency: 'USD',
        },
        openingBalanceDate: validDate,
      });
      expect(cmd.openingBalanceDate).toBe(validDate);
    },
  );

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

  it.each([
    ['-9223372036854775808', 'the true int8 minimum'],
    ['9223372036854775807', 'the int8 maximum'],
  ])('accepts %s (%s) at the boundary', (amountMinor) => {
    // int8 is asymmetric -- two's complement gives one more negative value than
    // positive -- so mirroring the maximum as the minimum would refuse a value
    // the bigint column stores happily.
    const command = createAccountCommand({
      name: 'Checking Account',
      type: 'checking',
      currency: 'USD',
      openingBalance: { amountMinor, currency: 'USD' },
    });
    expect(command.openingBalance?.amountMinor).toBe(amountMinor);
  });

  it('still refuses one step beyond the int8 minimum', () => {
    let thrown: unknown;
    try {
      createAccountCommand({
        name: 'Checking Account',
        type: 'checking',
        currency: 'USD',
        openingBalance: {
          amountMinor: '-9223372036854775809',
          currency: 'USD',
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountCommandValidationError);
  });
});
