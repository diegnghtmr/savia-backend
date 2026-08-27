import { describe, expect, it } from 'vitest';

import {
  createTransactionCommand,
  TransactionCommandValidationError,
  type CreateTransactionCommand,
} from '../../src/ledger/transaction-command.js';
import { TransactionSplitsUnsupportedError } from '../../src/ledger/splits-guard.js';
import type { FieldViolation } from '../../src/platform/problem-details.js';

function expectViolations(
  factory: () => unknown,
  assert: (violations: readonly FieldViolation[]) => void,
): void {
  try {
    factory();
    expect.fail('Expected TransactionCommandValidationError to be thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionCommandValidationError);
    if (error instanceof TransactionCommandValidationError) {
      assert(error.violations);
    }
  }
}

describe('createTransactionCommand', () => {
  const validMinimal = {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000000001',
    amount: {
      amountMinor: '15000',
      currency: 'USD',
    },
    occurredAt: '2026-08-20T10:30:00.000Z',
  };

  it('accepts valid minimal input and returns frozen command with defaults', () => {
    const command = createTransactionCommand(validMinimal);

    expect(command).toEqual({
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000001',
      amount: {
        amountMinor: '15000',
        currency: 'USD',
      },
      occurredAt: '2026-08-20T10:30:00.000Z',
      status: 'confirmed',
      categoryId: null,
      payeeId: null,
      description: null,
      notes: null,
      tagIds: [],
      receiptId: null,
    } satisfies CreateTransactionCommand);
    expect(Object.isFrozen(command)).toBe(true);
  });

  it('accepts all optional fields with explicit values', () => {
    const command = createTransactionCommand({
      ...validMinimal,
      status: 'pending',
      categoryId: '00000000-0000-0000-0000-000000000002',
      payeeId: '00000000-0000-0000-0000-000000000003',
      description: 'Business lunch',
      notes: 'Meeting with client',
      tagIds: [
        '00000000-0000-0000-0000-000000000004',
        '00000000-0000-0000-0000-000000000005',
      ],
      receiptId: '00000000-0000-0000-0000-000000000006',
    });

    expect(command).toEqual({
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000001',
      amount: {
        amountMinor: '15000',
        currency: 'USD',
      },
      occurredAt: '2026-08-20T10:30:00.000Z',
      status: 'pending',
      categoryId: '00000000-0000-0000-0000-000000000002',
      payeeId: '00000000-0000-0000-0000-000000000003',
      description: 'Business lunch',
      notes: 'Meeting with client',
      tagIds: [
        '00000000-0000-0000-0000-000000000004',
        '00000000-0000-0000-0000-000000000005',
      ],
      receiptId: '00000000-0000-0000-0000-000000000006',
    });
  });

  it('accepts explicit null for nullable fields', () => {
    const command = createTransactionCommand({
      ...validMinimal,
      categoryId: null,
      payeeId: null,
      description: null,
      notes: null,
      receiptId: null,
    });

    expect(command.categoryId).toBeNull();
    expect(command.payeeId).toBeNull();
    expect(command.description).toBeNull();
    expect(command.notes).toBeNull();
    expect(command.receiptId).toBeNull();
  });

  it('admits all declared TransactionType values', () => {
    const types = [
      'income',
      'expense',
      'adjustment',
      'refund',
      'debt_payment',
      'fund_contribution',
    ] as const;

    for (const type of types) {
      const command = createTransactionCommand({
        ...validMinimal,
        type,
      });
      expect(command.type).toBe(type);
    }
  });

  it('admits all declared status values for CreateTransactionRequest', () => {
    const statuses = ['draft', 'pending', 'confirmed'] as const;

    for (const status of statuses) {
      const command = createTransactionCommand({
        ...validMinimal,
        status,
      });
      expect(command.status).toBe(status);
    }
  });

  it('refuses reconciled and voided on transaction creation', () => {
    for (const status of ['reconciled', 'voided']) {
      expectViolations(
        () => createTransactionCommand({ ...validMinimal, status }),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'status',
            code: 'unsupported',
            message: expect.stringContaining('draft, pending, confirmed'),
          });
        },
      );
    }
  });

  it('refuses non-object body', () => {
    for (const invalid of [null, undefined, 'string', 123, []]) {
      expectViolations(
        () => createTransactionCommand(invalid),
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

  it('refuses disallowed unknown fields', () => {
    expectViolations(
      () =>
        createTransactionCommand({
          ...validMinimal,
          unknownField: 'value',
          extra: 123,
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'unknownField',
          code: 'not-allowed',
          message: 'is not allowed',
        });
        expect(violations).toContainEqual({
          field: 'extra',
          code: 'not-allowed',
          message: 'is not allowed',
        });
      },
    );
  });

  it('refuses invalid accountId', () => {
    expectViolations(
      () =>
        createTransactionCommand({ ...validMinimal, accountId: 'not-a-uuid' }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'accountId',
          code: 'invalid-format',
          message: 'must be a valid UUID',
        });
      },
    );
  });

  it('refuses invalid occurredAt date-time string', () => {
    for (const invalidDate of ['not-a-date', '2026-13-45', '2026-08-20']) {
      expectViolations(
        () =>
          createTransactionCommand({
            ...validMinimal,
            occurredAt: invalidDate,
          }),
        (violations) => {
          expect(violations).toContainEqual({
            field: 'occurredAt',
            code: 'invalid-date',
            message: expect.stringContaining('ISO 8601 date-time'),
          });
        },
      );
    }
  });

  it('refuses amountMinor that overflows int64 or cannot be negated', () => {
    // 9223372036854775808 overflows int64
    expectViolations(
      () =>
        createTransactionCommand({
          ...validMinimal,
          amount: { amountMinor: '9223372036854775808', currency: 'USD' },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'amount.amountMinor',
          code: 'invalid-range',
          message: expect.stringContaining('64-bit signed integer'),
        });
      },
    );

    // -9223372036854775808 cannot be negated within int64
    expectViolations(
      () =>
        createTransactionCommand({
          ...validMinimal,
          amount: { amountMinor: '-9223372036854775808', currency: 'USD' },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'amount.amountMinor',
          code: 'invalid-range',
          message: expect.stringContaining('64-bit signed integer'),
        });
      },
    );
  });

  it('refuses invalid currency', () => {
    expectViolations(
      () =>
        createTransactionCommand({
          ...validMinimal,
          amount: { amountMinor: '100', currency: 'XYZ' },
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'amount.currency',
          code: 'invalid-currency',
          message: expect.stringContaining('ISO 4217'),
        });
      },
    );
  });

  it('refuses duplicate tagIds', () => {
    expectViolations(
      () =>
        createTransactionCommand({
          ...validMinimal,
          tagIds: [
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000001',
          ],
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'tagIds',
          code: 'duplicate-values',
          message: expect.stringContaining('unique'),
        });
      },
    );
  });

  it('throws TransactionSplitsUnsupportedError when non-empty splits array is provided', () => {
    expect(() =>
      createTransactionCommand({
        ...validMinimal,
        splits: [
          {
            amount: { amountMinor: '5000', currency: 'USD' },
            categoryId: '00000000-0000-0000-0000-000000000002',
          },
        ],
      }),
    ).toThrow(TransactionSplitsUnsupportedError);
  });

  it('accepts empty splits array []', () => {
    const command = createTransactionCommand({
      ...validMinimal,
      splits: [],
    });
    expect(command.type).toBe('expense');
  });

  it('refuses non-array splits with validation error', () => {
    expectViolations(
      () =>
        createTransactionCommand({
          ...validMinimal,
          splits: 'not-an-array',
        }),
      (violations) => {
        expect(violations).toContainEqual({
          field: 'splits',
          code: 'invalid-type',
          message: 'must be an array',
        });
      },
    );
  });
});
