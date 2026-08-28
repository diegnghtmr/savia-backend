import {
  add,
  currencyValue,
  nullableStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type { CreateManualExchangeRateCommand } from './exchange-rate.port.js';

export class ExchangeRateCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Exchange rate command validation failed.');
    this.name = 'ExchangeRateCommandValidationError';
  }
}

const ALLOWED_FIELDS = [
  'baseCurrency',
  'quoteCurrency',
  'rate',
  'effectiveAt',
  'notes',
] as const;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const DECIMAL_PATTERN = /^-?[0-9]+(?:\.[0-9]+)?$/;
const ZERO_DECIMAL_PATTERN = /^0+(\.0+)?$/;

export function createManualExchangeRateCommand(
  input: unknown,
): CreateManualExchangeRateCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ExchangeRateCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let baseCurrency = '';
  if (body.baseCurrency === undefined) {
    add(violations, 'baseCurrency', 'required', 'must be a non-empty string');
  } else if (typeof body.baseCurrency !== 'string') {
    add(violations, 'baseCurrency', 'invalid-type', 'must be a string');
  } else {
    baseCurrency = currencyValue(body.baseCurrency, 'baseCurrency', violations);
  }

  let quoteCurrency = '';
  if (body.quoteCurrency === undefined) {
    add(violations, 'quoteCurrency', 'required', 'must be a non-empty string');
  } else if (typeof body.quoteCurrency !== 'string') {
    add(violations, 'quoteCurrency', 'invalid-type', 'must be a string');
  } else {
    quoteCurrency = currencyValue(
      body.quoteCurrency,
      'quoteCurrency',
      violations,
    );
  }

  if (
    baseCurrency &&
    quoteCurrency &&
    baseCurrency.toLowerCase() === quoteCurrency.toLowerCase()
  ) {
    add(
      violations,
      'quoteCurrency',
      'invalid-value',
      'baseCurrency and quoteCurrency must be distinct',
    );
  }

  let rate = '';
  if (body.rate === undefined) {
    add(violations, 'rate', 'required', 'must be a non-empty string');
  } else if (typeof body.rate !== 'string') {
    add(violations, 'rate', 'invalid-type', 'must be a string');
  } else if (!DECIMAL_PATTERN.test(body.rate)) {
    add(violations, 'rate', 'invalid-format', 'must be a valid decimal string');
  } else if (
    body.rate.startsWith('-') ||
    ZERO_DECIMAL_PATTERN.test(body.rate)
  ) {
    // D7: Rate must be strictly positive
    add(violations, 'rate', 'out-of-range', 'rate must be strictly positive');
  } else {
    rate = body.rate;
  }

  let effectiveAt = '';
  if (body.effectiveAt === undefined) {
    add(violations, 'effectiveAt', 'required', 'must be a non-empty string');
  } else if (typeof body.effectiveAt !== 'string') {
    add(violations, 'effectiveAt', 'invalid-type', 'must be a string');
  } else if (!ISO_DATE_TIME_PATTERN.test(body.effectiveAt)) {
    add(
      violations,
      'effectiveAt',
      'invalid-format',
      'must be a valid ISO 8601 date-time string',
    );
  } else {
    const timestamp = Date.parse(body.effectiveAt);
    if (Number.isNaN(timestamp)) {
      add(
        violations,
        'effectiveAt',
        'invalid-format',
        'must be a valid ISO 8601 date-time string',
      );
    } else {
      effectiveAt = new Date(timestamp).toISOString();
    }
  }

  const notes = nullableStringValue(body.notes, 'notes', violations, 500);

  if (violations.length > 0) {
    throw new ExchangeRateCommandValidationError(sortViolations(violations));
  }

  return {
    baseCurrency,
    quoteCurrency,
    rate,
    effectiveAt,
    ...(notes !== null && notes !== undefined ? { notes } : {}),
  };
}
