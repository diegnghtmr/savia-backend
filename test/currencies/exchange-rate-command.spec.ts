import { describe, expect, it } from 'vitest';

import {
  createManualExchangeRateCommand,
  ExchangeRateCommandValidationError,
} from '../../src/currencies/exchange-rate-command.js';

const EFFECTIVE_AT = '2026-08-28T12:00:00.000Z';

const VALID_INPUT = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: '0.9200',
  effectiveAt: EFFECTIVE_AT,
  notes: 'Manual rate entry',
};

describe('createManualExchangeRateCommand validation', () => {
  it('parses valid input with all required fields', () => {
    const cmd = createManualExchangeRateCommand(VALID_INPUT);
    expect(cmd).toEqual({
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9200',
      effectiveAt: EFFECTIVE_AT,
      notes: 'Manual rate entry',
    });
  });

  it('parses valid input without optional notes', () => {
    const cmd = createManualExchangeRateCommand({
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9200',
      effectiveAt: EFFECTIVE_AT,
    });
    expect(cmd).toEqual({
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9200',
      effectiveAt: EFFECTIVE_AT,
    });
  });

  it('parses valid input with notes as null', () => {
    const cmd = createManualExchangeRateCommand({
      ...VALID_INPUT,
      notes: null,
    });
    expect(cmd).toEqual({
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9200',
      effectiveAt: EFFECTIVE_AT,
    });
  });

  it('rejects same currency (baseCurrency === quoteCurrency)', () => {
    expect(() =>
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        quoteCurrency: 'USD',
      }),
    ).toThrow(ExchangeRateCommandValidationError);

    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        quoteCurrency: 'USD',
      });
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      const v = err.violations.find((vi) => vi.field === 'quoteCurrency');
      expect(v).toBeDefined();
      expect(v?.message).toContain('distinct');
    }
  });

  it('rejects same currency with case-insensitive match', () => {
    expect(() =>
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        quoteCurrency: 'usd',
      }),
    ).toThrow(ExchangeRateCommandValidationError);
  });

  it('rejects non-object body', () => {
    expect(() => createManualExchangeRateCommand(null)).toThrow(
      ExchangeRateCommandValidationError,
    );
    expect(() => createManualExchangeRateCommand('invalid')).toThrow(
      ExchangeRateCommandValidationError,
    );
    expect(() => createManualExchangeRateCommand([])).toThrow(
      ExchangeRateCommandValidationError,
    );
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        unknownField: 'extra',
        source: 'manual',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      expect(err.violations.some((v) => v.field === 'unknownField')).toBe(true);
      expect(err.violations.some((v) => v.field === 'source')).toBe(true);
    }
  });

  it('rejects missing required fields', () => {
    try {
      createManualExchangeRateCommand({});
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      const fields = err.violations.map((v) => v.field);
      expect(fields).toContain('baseCurrency');
      expect(fields).toContain('quoteCurrency');
      expect(fields).toContain('rate');
      expect(fields).toContain('effectiveAt');
    }
  });

  it('rejects invalid currency codes (not active ISO currencies)', () => {
    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        baseCurrency: 'INVALID',
        quoteCurrency: '123',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      expect(err.violations.some((v) => v.field === 'baseCurrency')).toBe(true);
      expect(err.violations.some((v) => v.field === 'quoteCurrency')).toBe(
        true,
      );
    }
  });

  it('rejects malformed decimal string for rate', () => {
    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        rate: 'not-a-number',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      expect(err.violations.some((v) => v.field === 'rate')).toBe(true);
    }
  });

  it('rejects non-positive rate (0, 0.00, negative)', () => {
    for (const nonPositiveRate of ['0', '0.00', '-1.50', '-0.0']) {
      try {
        createManualExchangeRateCommand({
          ...VALID_INPUT,
          rate: nonPositiveRate,
        });
        expect.unreachable(
          `Should have thrown for rate value: ${nonPositiveRate}`,
        );
      } catch (error) {
        const err = error as ExchangeRateCommandValidationError;
        const violation = err.violations.find((v) => v.field === 'rate');
        expect(violation).toBeDefined();
        expect(violation?.code).toBe('out-of-range');
        expect(violation?.message).toContain('strictly positive');
      }
    }
  });

  it('rejects invalid date-time format for effectiveAt', () => {
    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        effectiveAt: 'not-a-date',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      expect(err.violations.some((v) => v.field === 'effectiveAt')).toBe(true);
    }
  });

  it('rejects notes exceeding 500 characters', () => {
    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        notes: 'a'.repeat(501),
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      expect(err.violations.some((v) => v.field === 'notes')).toBe(true);
    }
  });

  it('rejects notes containing null characters', () => {
    try {
      createManualExchangeRateCommand({
        ...VALID_INPUT,
        notes: 'invalid\0null',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const err = error as ExchangeRateCommandValidationError;
      expect(err.violations.some((v) => v.field === 'notes')).toBe(true);
    }
  });
});
