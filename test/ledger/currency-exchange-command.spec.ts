import { describe, expect, it } from 'vitest';

import {
  createCurrencyExchangeCommand,
  CurrencyExchangeCommandValidationError,
} from '../../src/ledger/currency-exchange-command.js';

const SOURCE_ACCOUNT_ID = 'b3a1c2d3-1111-4222-8333-a44455556666';
const DEST_ACCOUNT_ID = 'c3a1c2d3-2222-4222-8333-a44455556666';
const OCCURRED_AT = '2026-08-25T10:00:00.000Z';

const VALID_INPUT = {
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  sourceAmount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  destinationAmount: {
    amountMinor: '4600',
    currency: 'EUR',
  },
  executedRate: '0.9200',
  occurredAt: OCCURRED_AT,
  description: 'Regular exchange',
};

describe('createCurrencyExchangeCommand validation', () => {
  it('parses valid input with all required fields', () => {
    const cmd = createCurrencyExchangeCommand(VALID_INPUT);
    expect(cmd).toEqual({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountId: DEST_ACCOUNT_ID,
      sourceAmount: {
        amountMinor: '5000',
        currency: 'USD',
      },
      destinationAmount: {
        amountMinor: '4600',
        currency: 'EUR',
      },
      executedRate: '0.9200',
      occurredAt: OCCURRED_AT,
      description: 'Regular exchange',
    });
  });

  it('parses valid input with optional referenceRate and fee', () => {
    const cmd = createCurrencyExchangeCommand({
      ...VALID_INPUT,
      referenceRate: '0.9150',
      fee: {
        amountMinor: '100',
        currency: 'USD',
      },
    });
    expect(cmd.referenceRate).toBe('0.9150');
    expect(cmd.fee).toEqual({
      amountMinor: '100',
      currency: 'USD',
    });
  });

  it('rejects self-exchange (sourceAccountId === destinationAccountId)', () => {
    expect(() =>
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        destinationAccountId: SOURCE_ACCOUNT_ID,
      }),
    ).toThrow(CurrencyExchangeCommandValidationError);

    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        destinationAccountId: SOURCE_ACCOUNT_ID,
      });
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      const v = err.violations.find(
        (vi) => vi.field === 'destinationAccountId',
      );
      expect(v).toBeDefined();
      expect(v?.message).toContain('distinct');
    }
  });

  it('rejects self-exchange with case-insensitive match', () => {
    expect(() =>
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        destinationAccountId: SOURCE_ACCOUNT_ID.toUpperCase(),
      }),
    ).toThrow(CurrencyExchangeCommandValidationError);
  });

  it('rejects non-object body', () => {
    expect(() => createCurrencyExchangeCommand(null)).toThrow(
      CurrencyExchangeCommandValidationError,
    );
    expect(() => createCurrencyExchangeCommand('invalid')).toThrow(
      CurrencyExchangeCommandValidationError,
    );
    expect(() => createCurrencyExchangeCommand([])).toThrow(
      CurrencyExchangeCommandValidationError,
    );
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        unknownField: 'extra',
        anotherBad: 123,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(err.violations.some((v) => v.field === 'unknownField')).toBe(true);
      expect(err.violations.some((v) => v.field === 'anotherBad')).toBe(true);
    }
  });

  it('rejects missing required fields', () => {
    try {
      createCurrencyExchangeCommand({});
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      const fields = err.violations.map((v) => v.field);
      expect(fields).toContain('sourceAccountId');
      expect(fields).toContain('destinationAccountId');
      expect(fields).toContain('sourceAmount');
      expect(fields).toContain('destinationAmount');
      expect(fields).toContain('executedRate');
      expect(fields).toContain('occurredAt');
    }
  });

  it('rejects malformed UUIDs for source and destination accounts', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        sourceAccountId: 'not-a-uuid',
        destinationAccountId: 'also-not-a-uuid',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(err.violations.some((v) => v.field === 'sourceAccountId')).toBe(
        true,
      );
      expect(
        err.violations.some((v) => v.field === 'destinationAccountId'),
      ).toBe(true);
    }
  });

  it('rejects non-positive sourceAmount or destinationAmount (0 or negative)', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        sourceAmount: { amountMinor: '0', currency: 'USD' },
        destinationAmount: { amountMinor: '-500', currency: 'EUR' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(
        err.violations.some((v) => v.field === 'sourceAmount.amountMinor'),
      ).toBe(true);
      expect(
        err.violations.some((v) => v.field === 'destinationAmount.amountMinor'),
      ).toBe(true);
    }
  });

  it('rejects invalid currency codes', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        sourceAmount: { amountMinor: '5000', currency: 'INVALID' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(
        err.violations.some((v) => v.field === 'sourceAmount.currency'),
      ).toBe(true);
    }
  });

  it('rejects invalid executedRate (non-decimal string, negative, zero)', () => {
    for (const badRate of ['not-a-rate', '-1.5', '0', '0.000']) {
      try {
        createCurrencyExchangeCommand({
          ...VALID_INPUT,
          executedRate: badRate,
        });
        expect.unreachable(`Should have thrown for rate: ${badRate}`);
      } catch (error) {
        const err = error as CurrencyExchangeCommandValidationError;
        expect(err.violations.some((v) => v.field === 'executedRate')).toBe(
          true,
        );
      }
    }
  });

  it('rejects invalid referenceRate (non-decimal string, negative, zero)', () => {
    for (const badRate of ['invalid', '-0.5', '0']) {
      try {
        createCurrencyExchangeCommand({
          ...VALID_INPUT,
          referenceRate: badRate,
        });
        expect.unreachable(`Should have thrown for referenceRate: ${badRate}`);
      } catch (error) {
        const err = error as CurrencyExchangeCommandValidationError;
        expect(err.violations.some((v) => v.field === 'referenceRate')).toBe(
          true,
        );
      }
    }
  });

  it('rejects invalid date-time format for occurredAt', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        occurredAt: 'not-a-date',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(err.violations.some((v) => v.field === 'occurredAt')).toBe(true);
    }
  });

  it('rejects description exceeding 500 characters', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        description: 'a'.repeat(501),
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(err.violations.some((v) => v.field === 'description')).toBe(true);
    }
  });

  it('rejects non-positive fee amount (0 or negative)', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        fee: { amountMinor: '0', currency: 'USD' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(err.violations.some((v) => v.field === 'fee.amountMinor')).toBe(
        true,
      );
    }
  });

  it('rejects extra fields inside sourceAmount, destinationAmount and fee objects', () => {
    try {
      createCurrencyExchangeCommand({
        ...VALID_INPUT,
        sourceAmount: {
          amountMinor: '5000',
          currency: 'USD',
          extra: true,
        },
        destinationAmount: {
          amountMinor: '4600',
          currency: 'EUR',
          unwanted: 123,
        },
        fee: { amountMinor: '100', currency: 'USD', spurious: 'yes' },
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as CurrencyExchangeCommandValidationError;
      expect(err.violations.some((v) => v.field === 'sourceAmount.extra')).toBe(
        true,
      );
      expect(
        err.violations.some((v) => v.field === 'destinationAmount.unwanted'),
      ).toBe(true);
      expect(err.violations.some((v) => v.field === 'fee.spurious')).toBe(true);
    }
  });
});
