import { describe, expect, it } from 'vitest';

import {
  createTransferCommand,
  TransferCommandValidationError,
} from '../../src/ledger/transfer-command.js';

const SOURCE_ACCOUNT_ID = 'b3a1c2d3-1111-4222-8333-a44455556666';
const DEST_ACCOUNT_ID = 'c3a1c2d3-2222-4222-8333-a44455556666';
const OCCURRED_AT = '2026-08-25T10:00:00.000Z';

const VALID_INPUT = {
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  amount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: OCCURRED_AT,
  description: 'Regular transfer',
};

describe('createTransferCommand validation', () => {
  it('parses valid input with all required fields', () => {
    const cmd = createTransferCommand(VALID_INPUT);
    expect(cmd).toEqual({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountId: DEST_ACCOUNT_ID,
      amount: {
        amountMinor: '5000',
        currency: 'USD',
      },
      occurredAt: OCCURRED_AT,
      description: 'Regular transfer',
    });
  });

  it('parses valid input with optional fee', () => {
    const cmd = createTransferCommand({
      ...VALID_INPUT,
      fee: {
        amountMinor: '100',
        currency: 'USD',
      },
    });
    expect(cmd.fee).toEqual({
      amountMinor: '100',
      currency: 'USD',
    });
  });

  it('rejects self-transfer (sourceAccountId === destinationAccountId)', () => {
    expect(() =>
      createTransferCommand({
        ...VALID_INPUT,
        destinationAccountId: SOURCE_ACCOUNT_ID,
      }),
    ).toThrow(TransferCommandValidationError);

    try {
      createTransferCommand({
        ...VALID_INPUT,
        destinationAccountId: SOURCE_ACCOUNT_ID,
      });
    } catch (error) {
      const err = error as TransferCommandValidationError;
      const v = err.violations.find(
        (vi) => vi.field === 'destinationAccountId',
      );
      expect(v).toBeDefined();
      expect(v?.message).toContain('distinct');
    }
  });

  it('rejects self-transfer with case-insensitive match', () => {
    expect(() =>
      createTransferCommand({
        ...VALID_INPUT,
        destinationAccountId: SOURCE_ACCOUNT_ID.toUpperCase(),
      }),
    ).toThrow(TransferCommandValidationError);
  });

  it('rejects non-object body', () => {
    expect(() => createTransferCommand(null)).toThrow(
      TransferCommandValidationError,
    );
    expect(() => createTransferCommand('invalid')).toThrow(
      TransferCommandValidationError,
    );
    expect(() => createTransferCommand([])).toThrow(
      TransferCommandValidationError,
    );
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        unknownField: 'extra',
        anotherBad: 123,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'unknownField')).toBe(true);
      expect(err.violations.some((v) => v.field === 'anotherBad')).toBe(true);
    }
  });

  it('rejects missing required fields', () => {
    try {
      createTransferCommand({});
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      const fields = err.violations.map((v) => v.field);
      expect(fields).toContain('sourceAccountId');
      expect(fields).toContain('destinationAccountId');
      expect(fields).toContain('amount');
      expect(fields).toContain('occurredAt');
    }
  });

  it('rejects malformed UUIDs for source and destination accounts', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        sourceAccountId: 'not-a-uuid',
        destinationAccountId: 'also-not-a-uuid',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'sourceAccountId')).toBe(
        true,
      );
      expect(
        err.violations.some((v) => v.field === 'destinationAccountId'),
      ).toBe(true);
    }
  });

  it('rejects non-positive amount (0 or negative)', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        amount: { amountMinor: '0', currency: 'USD' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'amount.amountMinor')).toBe(
        true,
      );
    }
  });

  it('rejects invalid currency codes (not 3 uppercase letters)', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        amount: { amountMinor: '5000', currency: 'INVALID' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'amount.currency')).toBe(
        true,
      );
    }
  });

  it('rejects invalid date-time format for occurredAt', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        occurredAt: 'not-a-date',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'occurredAt')).toBe(true);
    }
  });

  it('rejects description exceeding 500 characters', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        description: 'a'.repeat(501),
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'description')).toBe(true);
    }
  });

  it('rejects non-positive fee amount (0 or negative)', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        fee: { amountMinor: '0', currency: 'USD' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'fee.amountMinor')).toBe(
        true,
      );
    }
  });

  it('rejects extra fields inside amount and fee objects', () => {
    try {
      createTransferCommand({
        ...VALID_INPUT,
        amount: { amountMinor: '5000', currency: 'USD', extra: true },
        fee: { amountMinor: '100', currency: 'USD', spurious: 'yes' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as TransferCommandValidationError;
      expect(err.violations.some((v) => v.field === 'amount.extra')).toBe(true);
      expect(err.violations.some((v) => v.field === 'fee.spurious')).toBe(true);
    }
  });
});
