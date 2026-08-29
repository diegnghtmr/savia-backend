import { describe, expect, it } from 'vitest';
import {
  createExchangeRateListQuery,
  ExchangeRateQueryValidationError,
} from '../../src/currencies/exchange-rate-query.js';

describe('createExchangeRateListQuery', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';

  it('creates query with workspaceId only when no filters are provided', () => {
    const query = createExchangeRateListQuery({ workspaceId });
    expect(query).toEqual({ workspaceId });
  });

  it('creates query with valid baseCurrency filter', () => {
    const query = createExchangeRateListQuery({
      workspaceId,
      baseCurrencyParam: 'USD',
    });
    expect(query).toEqual({
      workspaceId,
      baseCurrency: 'USD',
    });
  });

  it('creates query with valid quoteCurrency filter', () => {
    const query = createExchangeRateListQuery({
      workspaceId,
      quoteCurrencyParam: 'EUR',
    });
    expect(query).toEqual({
      workspaceId,
      quoteCurrency: 'EUR',
    });
  });

  it('creates query with valid from date filter', () => {
    const query = createExchangeRateListQuery({
      workspaceId,
      fromParam: '2026-08-01',
    });
    expect(query).toEqual({
      workspaceId,
      from: '2026-08-01',
    });
  });

  it('creates query with valid to date filter', () => {
    const query = createExchangeRateListQuery({
      workspaceId,
      toParam: '2026-08-28',
    });
    expect(query).toEqual({
      workspaceId,
      to: '2026-08-28',
    });
  });

  it('creates query with all filters combined', () => {
    const query = createExchangeRateListQuery({
      workspaceId,
      baseCurrencyParam: 'USD',
      quoteCurrencyParam: 'EUR',
      fromParam: '2026-08-01',
      toParam: '2026-08-28',
    });
    expect(query).toEqual({
      workspaceId,
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      from: '2026-08-01',
      to: '2026-08-28',
    });
  });

  it('throws ExchangeRateQueryValidationError when baseCurrency is lowercase (D5)', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        baseCurrencyParam: 'usd',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('throws ExchangeRateQueryValidationError when baseCurrency is not 3 letters', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        baseCurrencyParam: 'US',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('throws ExchangeRateQueryValidationError when baseCurrency is not an active currency', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        baseCurrencyParam: 'ZZZ',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('throws ExchangeRateQueryValidationError when quoteCurrency is invalid', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        quoteCurrencyParam: 'eur',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('throws ExchangeRateQueryValidationError when from date is malformed (D5)', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        fromParam: 'not-a-date',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('throws ExchangeRateQueryValidationError when from date is an impossible calendar date', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        fromParam: '2026-02-30',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('throws ExchangeRateQueryValidationError when to date is malformed', () => {
    expect(() =>
      createExchangeRateListQuery({
        workspaceId,
        toParam: '2026/08/28',
      }),
    ).toThrow(ExchangeRateQueryValidationError);
  });

  it('accumulates multiple violations when multiple query parameters are invalid', () => {
    try {
      createExchangeRateListQuery({
        workspaceId,
        baseCurrencyParam: 'invalid',
        fromParam: 'bad-date',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ExchangeRateQueryValidationError);
      const validationError = error as ExchangeRateQueryValidationError;
      expect(validationError.violations).toHaveLength(2);
      expect(validationError.violations.map((v) => v.field)).toEqual([
        'baseCurrency',
        'from',
      ]);
    }
  });
});
