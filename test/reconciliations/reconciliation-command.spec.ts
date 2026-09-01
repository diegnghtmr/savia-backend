import { describe, expect, it } from 'vitest';
import {
  createReconciliationCommand,
  ReconciliationCommandValidationError,
} from '../../src/reconciliations/reconciliation-command.js';

const VALID_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

describe('createReconciliationCommand validator', () => {
  const validPayload = {
    accountId: VALID_ACCOUNT_ID,
    statementDate: '2026-08-31',
    statementBalance: {
      amountMinor: '150000',
      currency: 'USD',
    },
    notes: 'End of month reconciliation',
  };

  it('accepts valid input with all fields and preserves values', () => {
    const cmd = createReconciliationCommand(validPayload);
    expect(cmd).toEqual({
      accountId: VALID_ACCOUNT_ID,
      statementDate: '2026-08-31',
      statementBalance: {
        amountMinor: '150000',
        currency: 'USD',
      },
      notes: 'End of month reconciliation',
    });
  });

  it('accepts valid input without optional notes', () => {
    const cmd = createReconciliationCommand({
      accountId: VALID_ACCOUNT_ID,
      statementDate: '2026-08-31',
      statementBalance: {
        amountMinor: '0',
        currency: 'EUR',
      },
    });
    expect(cmd).toEqual({
      accountId: VALID_ACCOUNT_ID,
      statementDate: '2026-08-31',
      statementBalance: {
        amountMinor: '0',
        currency: 'EUR',
      },
    });
    expect(cmd.notes).toBeUndefined();
  });

  it('accepts valid input with explicit null notes', () => {
    const cmd = createReconciliationCommand({
      accountId: VALID_ACCOUNT_ID,
      statementDate: '2026-08-31',
      statementBalance: {
        amountMinor: '-500',
        currency: 'GBP',
      },
      notes: null,
    });
    expect(cmd).toEqual({
      accountId: VALID_ACCOUNT_ID,
      statementDate: '2026-08-31',
      statementBalance: {
        amountMinor: '-500',
        currency: 'GBP',
      },
    });
    expect(cmd.notes).toBeUndefined();
  });

  it('rejects non-object body (null, array, string)', () => {
    expect(() => createReconciliationCommand(null)).toThrow(
      ReconciliationCommandValidationError,
    );
    expect(() => createReconciliationCommand([])).toThrow(
      ReconciliationCommandValidationError,
    );
    expect(() => createReconciliationCommand('invalid')).toThrow(
      ReconciliationCommandValidationError,
    );
  });

  it('rejects disallowed extra fields on root', () => {
    try {
      createReconciliationCommand({
        ...validPayload,
        systemBalance: { amountMinor: '100', currency: 'USD' },
        extraField: 'not allowed',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationCommandValidationError);
      const violations = (error as ReconciliationCommandValidationError)
        .violations;
      expect(violations.some((v) => v.field === 'systemBalance')).toBe(true);
      expect(violations.some((v) => v.field === 'extraField')).toBe(true);
    }
  });

  it('rejects missing or invalid accountId', () => {
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        accountId: undefined,
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        accountId: 12345,
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        accountId: 'not-a-valid-uuid',
      }),
    ).toThrow(ReconciliationCommandValidationError);
  });

  it('rejects missing or invalid statementDate format or calendar date', () => {
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementDate: undefined,
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementDate: 'invalid-date',
      }),
    ).toThrow(ReconciliationCommandValidationError);

    // Invalid calendar date (Feb 30)
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementDate: '2026-02-30',
      }),
    ).toThrow(ReconciliationCommandValidationError);
  });

  it('rejects statementDate in the future (RULING 72)', () => {
    const futureDate = '2099-12-31';
    try {
      createReconciliationCommand({
        ...validPayload,
        statementDate: futureDate,
      });
      expect.unreachable('Should have thrown for future date');
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationCommandValidationError);
      const violations = (error as ReconciliationCommandValidationError)
        .violations;
      expect(
        violations.some(
          (v) =>
            v.field === 'statementDate' &&
            v.message === 'statementDate must not be in the future',
        ),
      ).toBe(true);
    }
  });

  it('rejects missing or non-object statementBalance', () => {
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: undefined,
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: '1500 USD',
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: null,
      }),
    ).toThrow(ReconciliationCommandValidationError);
  });

  it('rejects disallowed extra keys in statementBalance', () => {
    try {
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '100',
          currency: 'USD',
          rate: '1.0',
        },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationCommandValidationError);
      const violations = (error as ReconciliationCommandValidationError)
        .violations;
      expect(violations.some((v) => v.field === 'statementBalance.rate')).toBe(
        true,
      );
    }
  });

  it('rejects missing or invalid amountMinor in statementBalance', () => {
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '12.34', // decimal instead of minor units
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: 'abc',
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '100\x00', // null character
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    // Out of int64 range
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '9223372036854775808', // INT64_MAX + 1
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '-9223372036854775809', // INT64_MIN - 1
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '99999999999999999999999999999999',
          currency: 'USD',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);
  });

  it('accepts exact signed 64-bit boundary values for amountMinor', () => {
    const cmdMax = createReconciliationCommand({
      ...validPayload,
      statementBalance: {
        amountMinor: '9223372036854775807',
        currency: 'USD',
      },
    });
    expect(cmdMax.statementBalance.amountMinor).toBe('9223372036854775807');

    const cmdMin = createReconciliationCommand({
      ...validPayload,
      statementBalance: {
        amountMinor: '-9223372036854775808',
        currency: 'USD',
      },
    });
    expect(cmdMin.statementBalance.amountMinor).toBe('-9223372036854775808');
  });

  it('rejects missing or invalid currency in statementBalance', () => {
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '100',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        statementBalance: {
          amountMinor: '100',
          currency: 'INVALID',
        },
      }),
    ).toThrow(ReconciliationCommandValidationError);
  });

  it('rejects notes exceeding 1000 characters or containing null characters', () => {
    const longNotes = 'a'.repeat(1001);
    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        notes: longNotes,
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        notes: 'notes\0with null',
      }),
    ).toThrow(ReconciliationCommandValidationError);

    expect(() =>
      createReconciliationCommand({
        ...validPayload,
        notes: 12345,
      }),
    ).toThrow(ReconciliationCommandValidationError);
  });
});
