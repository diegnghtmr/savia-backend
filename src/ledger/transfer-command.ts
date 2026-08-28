import {
  add,
  currencyValue,
  nullableStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { CreateTransferCommand } from './transfer.port.js';
import type { Money } from './ledger.port.js';

export class TransferCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Transfer command validation failed.');
    this.name = 'TransferCommandValidationError';
  }
}

const ALLOWED_FIELDS = [
  'sourceAccountId',
  'destinationAccountId',
  'amount',
  'occurredAt',
  'fee',
  'description',
] as const;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const INT8_MAX = 9223372036854775807n;

export function createTransferCommand(input: unknown): CreateTransferCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new TransferCommandValidationError(Object.freeze(violations));
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

  let amount: Money = { amountMinor: '0', currency: '' };
  if (body.amount === undefined) {
    add(violations, 'amount', 'required', 'must be an object');
  } else if (
    typeof body.amount !== 'object' ||
    body.amount === null ||
    Array.isArray(body.amount)
  ) {
    add(violations, 'amount', 'invalid-type', 'must be an object');
  } else {
    const amountObj = body.amount as Record<string, unknown>;
    for (const key of Object.keys(amountObj)) {
      if (key !== 'amountMinor' && key !== 'currency') {
        add(violations, `amount.${key}`, 'not-allowed', 'is not allowed');
      }
    }

    let amountMinor = '';
    if (amountObj.amountMinor === undefined) {
      add(
        violations,
        'amount.amountMinor',
        'required',
        'must be a non-empty string',
      );
    } else if (typeof amountObj.amountMinor !== 'string') {
      add(violations, 'amount.amountMinor', 'invalid-type', 'must be a string');
    } else if (!/^\d+$/.test(amountObj.amountMinor)) {
      add(
        violations,
        'amount.amountMinor',
        'invalid-format',
        'must be a non-negative integer string',
      );
    } else {
      try {
        const val = BigInt(amountObj.amountMinor);
        if (val <= 0n) {
          add(
            violations,
            'amount.amountMinor',
            'out-of-range',
            'amount must be strictly positive',
          );
        } else if (val > INT8_MAX) {
          add(
            violations,
            'amount.amountMinor',
            'out-of-range',
            'must be an integer within int8 range',
          );
        } else {
          amountMinor = amountObj.amountMinor;
        }
      } catch {
        add(
          violations,
          'amount.amountMinor',
          'invalid-format',
          'must be a valid integer',
        );
      }
    }

    const currency = currencyValue(
      amountObj.currency,
      'amount.currency',
      violations,
    );
    amount = { amountMinor, currency };
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

  let fee: Money | undefined;
  if ('fee' in body && body.fee !== undefined) {
    if (
      typeof body.fee !== 'object' ||
      body.fee === null ||
      Array.isArray(body.fee)
    ) {
      add(violations, 'fee', 'invalid-type', 'must be an object');
    } else {
      const feeObj = body.fee as Record<string, unknown>;
      for (const key of Object.keys(feeObj)) {
        if (key !== 'amountMinor' && key !== 'currency') {
          add(violations, `fee.${key}`, 'not-allowed', 'is not allowed');
        }
      }
      let feeMinor = '';
      if (feeObj.amountMinor === undefined) {
        add(
          violations,
          'fee.amountMinor',
          'required',
          'must be a non-empty string',
        );
      } else if (typeof feeObj.amountMinor !== 'string') {
        add(violations, 'fee.amountMinor', 'invalid-type', 'must be a string');
      } else if (!/^\d+$/.test(feeObj.amountMinor)) {
        add(
          violations,
          'fee.amountMinor',
          'invalid-format',
          'must be a non-negative integer string',
        );
      } else {
        try {
          const val = BigInt(feeObj.amountMinor);
          if (val <= 0n) {
            add(
              violations,
              'fee.amountMinor',
              'out-of-range',
              'fee amount must be strictly positive',
            );
          } else if (val > INT8_MAX) {
            add(
              violations,
              'fee.amountMinor',
              'out-of-range',
              'must be an integer within int8 range',
            );
          } else {
            feeMinor = feeObj.amountMinor;
          }
        } catch {
          add(
            violations,
            'fee.amountMinor',
            'invalid-format',
            'must be a valid integer',
          );
        }
      }
      const feeCurrency = currencyValue(
        feeObj.currency,
        'fee.currency',
        violations,
      );
      fee = { amountMinor: feeMinor, currency: feeCurrency };
    }
  }

  const description = nullableStringValue(
    body.description,
    'description',
    violations,
    500,
  );

  if (violations.length > 0) {
    throw new TransferCommandValidationError(sortViolations(violations));
  }

  return {
    sourceAccountId,
    destinationAccountId,
    amount,
    occurredAt,
    ...(fee ? { fee } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}
