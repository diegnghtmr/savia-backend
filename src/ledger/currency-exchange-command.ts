import {
  add,
  currencyValue,
  nullableStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { CreateCurrencyExchangeCommand } from './currency-exchange.port.js';
import type { Money } from './ledger.port.js';

export class CurrencyExchangeCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Currency exchange command validation failed.');
    this.name = 'CurrencyExchangeCommandValidationError';
  }
}

const ALLOWED_FIELDS = [
  'sourceAccountId',
  'destinationAccountId',
  'sourceAmount',
  'destinationAmount',
  'executedRate',
  'referenceRate',
  'fee',
  'occurredAt',
  'description',
] as const;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const DECIMAL_PATTERN = /^-?[0-9]+(?:\.[0-9]+)?$/;
const ZERO_DECIMAL_PATTERN = /^0+(\.0+)?$/;

const INT8_MAX = 9223372036854775807n;

function parseMoneyField(
  input: unknown,
  fieldName: 'sourceAmount' | 'destinationAmount' | 'fee',
  violations: FieldViolation[],
  required: boolean,
): Money | undefined {
  if (input === undefined) {
    if (required) {
      add(violations, fieldName, 'required', 'must be an object');
    }
    return undefined;
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, fieldName, 'invalid-type', 'must be an object');
    return undefined;
  }

  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'amountMinor' && key !== 'currency') {
      add(violations, `${fieldName}.${key}`, 'not-allowed', 'is not allowed');
    }
  }

  let amountMinor = '';
  if (obj.amountMinor === undefined) {
    add(
      violations,
      `${fieldName}.amountMinor`,
      'required',
      'must be a non-empty string',
    );
  } else if (typeof obj.amountMinor !== 'string') {
    add(
      violations,
      `${fieldName}.amountMinor`,
      'invalid-type',
      'must be a string',
    );
  } else if (!/^\d+$/.test(obj.amountMinor)) {
    add(
      violations,
      `${fieldName}.amountMinor`,
      'invalid-format',
      'must be a non-negative integer string',
    );
  } else {
    try {
      const val = BigInt(obj.amountMinor);
      if (val <= 0n) {
        add(
          violations,
          `${fieldName}.amountMinor`,
          'out-of-range',
          `${fieldName === 'fee' ? 'fee amount' : 'amount'} must be strictly positive`,
        );
      } else if (val > INT8_MAX) {
        add(
          violations,
          `${fieldName}.amountMinor`,
          'out-of-range',
          'must be an integer within int8 range',
        );
      } else {
        amountMinor = obj.amountMinor;
      }
    } catch {
      add(
        violations,
        `${fieldName}.amountMinor`,
        'invalid-format',
        'must be a valid integer',
      );
    }
  }

  const currency = currencyValue(
    obj.currency,
    `${fieldName}.currency`,
    violations,
  );
  return { amountMinor, currency };
}

export function createCurrencyExchangeCommand(
  input: unknown,
): CreateCurrencyExchangeCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new CurrencyExchangeCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let sourceAccountId = '';
  if (body.sourceAccountId === undefined) {
    add(
      violations,
      'sourceAccountId',
      'required',
      'must be a non-empty string',
    );
  } else if (typeof body.sourceAccountId !== 'string') {
    add(violations, 'sourceAccountId', 'invalid-type', 'must be a string');
  } else if (!UUID_PATTERN.test(body.sourceAccountId)) {
    add(
      violations,
      'sourceAccountId',
      'invalid-format',
      'must be a valid UUID',
    );
  } else {
    sourceAccountId = body.sourceAccountId;
  }

  let destinationAccountId = '';
  if (body.destinationAccountId === undefined) {
    add(
      violations,
      'destinationAccountId',
      'required',
      'must be a non-empty string',
    );
  } else if (typeof body.destinationAccountId !== 'string') {
    add(violations, 'destinationAccountId', 'invalid-type', 'must be a string');
  } else if (!UUID_PATTERN.test(body.destinationAccountId)) {
    add(
      violations,
      'destinationAccountId',
      'invalid-format',
      'must be a valid UUID',
    );
  } else {
    destinationAccountId = body.destinationAccountId;
  }

  if (
    sourceAccountId &&
    destinationAccountId &&
    sourceAccountId.toLowerCase() === destinationAccountId.toLowerCase()
  ) {
    add(
      violations,
      'destinationAccountId',
      'invalid-value',
      'sourceAccountId and destinationAccountId must be distinct',
    );
  }

  const sourceAmount = parseMoneyField(
    body.sourceAmount,
    'sourceAmount',
    violations,
    true,
  ) ?? {
    amountMinor: '0',
    currency: '',
  };

  const destinationAmount = parseMoneyField(
    body.destinationAmount,
    'destinationAmount',
    violations,
    true,
  ) ?? {
    amountMinor: '0',
    currency: '',
  };

  let executedRate = '';
  if (body.executedRate === undefined) {
    add(violations, 'executedRate', 'required', 'must be a non-empty string');
  } else if (typeof body.executedRate !== 'string') {
    add(violations, 'executedRate', 'invalid-type', 'must be a string');
  } else if (!DECIMAL_PATTERN.test(body.executedRate)) {
    add(
      violations,
      'executedRate',
      'invalid-format',
      'must be a valid decimal string',
    );
  } else if (
    body.executedRate.startsWith('-') ||
    ZERO_DECIMAL_PATTERN.test(body.executedRate)
  ) {
    add(
      violations,
      'executedRate',
      'out-of-range',
      'rate must be strictly positive',
    );
  } else {
    executedRate = body.executedRate;
  }

  let referenceRate: string | null | undefined;
  if ('referenceRate' in body && body.referenceRate !== undefined) {
    if (body.referenceRate === null) {
      referenceRate = null;
    } else if (typeof body.referenceRate !== 'string') {
      add(violations, 'referenceRate', 'invalid-type', 'must be a string');
    } else if (!DECIMAL_PATTERN.test(body.referenceRate)) {
      add(
        violations,
        'referenceRate',
        'invalid-format',
        'must be a valid decimal string',
      );
    } else if (
      body.referenceRate.startsWith('-') ||
      ZERO_DECIMAL_PATTERN.test(body.referenceRate)
    ) {
      add(
        violations,
        'referenceRate',
        'out-of-range',
        'rate must be strictly positive',
      );
    } else {
      referenceRate = body.referenceRate;
    }
  }

  let fee: Money | undefined;
  if ('fee' in body && body.fee !== undefined) {
    fee = parseMoneyField(body.fee, 'fee', violations, false);
  }

  let occurredAt = '';
  if (body.occurredAt === undefined) {
    add(violations, 'occurredAt', 'required', 'must be a non-empty string');
  } else if (typeof body.occurredAt !== 'string') {
    add(violations, 'occurredAt', 'invalid-type', 'must be a string');
  } else if (!ISO_DATE_TIME_PATTERN.test(body.occurredAt)) {
    add(
      violations,
      'occurredAt',
      'invalid-format',
      'must be a valid ISO 8601 date-time string',
    );
  } else {
    const timestamp = Date.parse(body.occurredAt);
    if (Number.isNaN(timestamp)) {
      add(
        violations,
        'occurredAt',
        'invalid-format',
        'must be a valid ISO 8601 date-time string',
      );
    } else {
      occurredAt = new Date(timestamp).toISOString();
    }
  }

  const description = nullableStringValue(
    body.description,
    'description',
    violations,
    500,
  );

  if (violations.length > 0) {
    throw new CurrencyExchangeCommandValidationError(
      sortViolations(violations),
    );
  }

  return {
    sourceAccountId,
    destinationAccountId,
    sourceAmount,
    destinationAmount,
    executedRate,
    ...(referenceRate !== undefined ? { referenceRate } : {}),
    ...(fee ? { fee } : {}),
    occurredAt,
    ...(description !== undefined ? { description } : {}),
  };
}
