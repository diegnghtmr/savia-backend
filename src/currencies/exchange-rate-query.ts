import {
  ACTIVE_CURRENCIES,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { ExchangeRateListQuery } from './exchange-rate.port.js';

export class ExchangeRateQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Exchange rate list query validation failed.');
    this.name = 'ExchangeRateQueryValidationError';
  }
}

export interface ExchangeRateListQueryInput {
  readonly workspaceId: string;
  readonly baseCurrencyParam?: string;
  readonly quoteCurrencyParam?: string;
  readonly fromParam?: string;
  readonly toParam?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function isValidDate(dateStr: string): boolean {
  if (!DATE_PATTERN.test(dateStr)) {
    return false;
  }
  const parsedDate = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime())) {
    return false;
  }
  return parsedDate.toISOString().slice(0, 10) === dateStr;
}

export function createExchangeRateListQuery(
  input: ExchangeRateListQueryInput,
): ExchangeRateListQuery {
  const violations: FieldViolation[] = [];

  let baseCurrency: string | undefined;
  if (input.baseCurrencyParam !== undefined) {
    if (
      !CURRENCY_CODE_PATTERN.test(input.baseCurrencyParam) ||
      !ACTIVE_CURRENCIES.has(input.baseCurrencyParam)
    ) {
      violations.push(
        Object.freeze({
          field: 'baseCurrency',
          code: 'invalid',
          message:
            'baseCurrency must be a 3-letter uppercase ISO 4217 currency code.',
        }),
      );
    } else {
      baseCurrency = input.baseCurrencyParam;
    }
  }

  let quoteCurrency: string | undefined;
  if (input.quoteCurrencyParam !== undefined) {
    if (
      !CURRENCY_CODE_PATTERN.test(input.quoteCurrencyParam) ||
      !ACTIVE_CURRENCIES.has(input.quoteCurrencyParam)
    ) {
      violations.push(
        Object.freeze({
          field: 'quoteCurrency',
          code: 'invalid',
          message:
            'quoteCurrency must be a 3-letter uppercase ISO 4217 currency code.',
        }),
      );
    } else {
      quoteCurrency = input.quoteCurrencyParam;
    }
  }

  let from: string | undefined;
  if (input.fromParam !== undefined) {
    if (!isValidDate(input.fromParam)) {
      violations.push(
        Object.freeze({
          field: 'from',
          code: 'invalid',
          message: 'from must be a valid ISO 8601 date (YYYY-MM-DD).',
        }),
      );
    } else {
      from = input.fromParam;
    }
  }

  let to: string | undefined;
  if (input.toParam !== undefined) {
    if (!isValidDate(input.toParam)) {
      violations.push(
        Object.freeze({
          field: 'to',
          code: 'invalid',
          message: 'to must be a valid ISO 8601 date (YYYY-MM-DD).',
        }),
      );
    } else {
      to = input.toParam;
    }
  }

  if (violations.length > 0) {
    throw new ExchangeRateQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    ...(baseCurrency === undefined ? {} : { baseCurrency }),
    ...(quoteCurrency === undefined ? {} : { quoteCurrency }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}
