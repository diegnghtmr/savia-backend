import {
  add,
  currencyValue,
  nullableStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { CreateReconciliationCommand } from './reconciliation.port.js';

export class ReconciliationCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Reconciliation command validation failed.');
    this.name = 'ReconciliationCommandValidationError';
  }
}

const ALLOWED_FIELDS = [
  'accountId',
  'statementDate',
  'statementBalance',
  'notes',
] as const;
const COMPLETE_ALLOWED_FIELDS = [
  'transactionIds',
  'createAdjustment',
  'adjustmentReason',
] as const;

const ALLOWED_MONEY_KEYS = ['amountMinor', 'currency'] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

function isValidDate(dateStr: string): boolean {
  if (!DATE_PATTERN.test(dateStr)) {
    return false;
  }
  const parsed = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString().slice(0, 10) === dateStr;
}

export function createReconciliationCommand(
  input: unknown,
): CreateReconciliationCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ReconciliationCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let accountId = '';
  if (body.accountId === undefined) {
    add(violations, 'accountId', 'required', 'must be a non-empty string');
  } else if (typeof body.accountId !== 'string') {
    add(violations, 'accountId', 'invalid-type', 'must be a string');
  } else if (!UUID_PATTERN.test(body.accountId)) {
    add(violations, 'accountId', 'invalid-format', 'must be a valid UUID');
  } else {
    accountId = body.accountId;
  }

  let statementDate = '';
  if (body.statementDate === undefined) {
    add(violations, 'statementDate', 'required', 'must be a non-empty string');
  } else if (typeof body.statementDate !== 'string') {
    add(violations, 'statementDate', 'invalid-type', 'must be a string');
  } else if (!isValidDate(body.statementDate)) {
    add(
      violations,
      'statementDate',
      'invalid-format',
      'must be a valid ISO 8601 date (YYYY-MM-DD)',
    );
  } else {
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (body.statementDate > todayUtc) {
      add(
        violations,
        'statementDate',
        'out-of-range',
        'statementDate must not be in the future',
      );
    } else {
      statementDate = body.statementDate;
    }
  }

  let statementBalance: CreateReconciliationCommand['statementBalance'] = {
    amountMinor: '',
    currency: '',
  };

  if (body.statementBalance === undefined) {
    add(violations, 'statementBalance', 'required', 'must be an object');
  } else if (
    typeof body.statementBalance !== 'object' ||
    body.statementBalance === null ||
    Array.isArray(body.statementBalance)
  ) {
    add(violations, 'statementBalance', 'invalid-type', 'must be an object');
  } else {
    const bal = body.statementBalance as Record<string, unknown>;

    for (const key of Object.keys(bal)) {
      if (
        !ALLOWED_MONEY_KEYS.includes(key as (typeof ALLOWED_MONEY_KEYS)[number])
      ) {
        add(
          violations,
          `statementBalance.${key}`,
          'not-allowed',
          'is not allowed',
        );
      }
    }

    let amountMinor = '';
    if (bal.amountMinor === undefined) {
      add(
        violations,
        'statementBalance.amountMinor',
        'required',
        'must be a non-empty string',
      );
    } else if (typeof bal.amountMinor !== 'string') {
      add(
        violations,
        'statementBalance.amountMinor',
        'invalid-type',
        'must be a string',
      );
    } else if (bal.amountMinor.includes('\0')) {
      add(
        violations,
        'statementBalance.amountMinor',
        'invalid-characters',
        'must not contain null characters',
      );
    } else {
      const trimmed = bal.amountMinor.trim();
      if (!trimmed) {
        add(
          violations,
          'statementBalance.amountMinor',
          'required',
          'must be a non-empty string',
        );
      } else if (!/^-?[0-9]+$/.test(trimmed)) {
        add(
          violations,
          'statementBalance.amountMinor',
          'invalid-format',
          'must be an integer minor-unit amount string',
        );
      } else {
        const val = BigInt(trimmed);
        if (val < INT64_MIN || val > INT64_MAX) {
          add(
            violations,
            'statementBalance.amountMinor',
            'out-of-range',
            'amountMinor must fit within signed 64-bit integer range',
          );
        } else {
          amountMinor = trimmed;
        }
      }
    }

    let currency = '';
    if (bal.currency === undefined) {
      add(
        violations,
        'statementBalance.currency',
        'required',
        'must be a non-empty string',
      );
    } else if (typeof bal.currency !== 'string') {
      add(
        violations,
        'statementBalance.currency',
        'invalid-type',
        'must be a string',
      );
    } else {
      currency = currencyValue(
        bal.currency,
        'statementBalance.currency',
        violations,
      );
    }

    statementBalance = {
      amountMinor,
      currency,
    };
  }

  const notes = nullableStringValue(body.notes, 'notes', violations, 1000);

  if (violations.length > 0) {
    throw new ReconciliationCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    accountId,
    statementDate,
    statementBalance,
    ...(notes !== null && notes !== undefined ? { notes } : {}),
  };
}

export function completeReconciliationCommand(
  input: unknown,
): import('./reconciliation.port.js').CompleteReconciliationCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
  }
  const body = (input ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !COMPLETE_ALLOWED_FIELDS.includes(
        key as (typeof COMPLETE_ALLOWED_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }
  const ids: string[] = [];
  if (!Array.isArray(body.transactionIds)) {
    add(violations, 'transactionIds', 'required', 'must be an array');
  } else {
    const seen = new Set<string>();
    body.transactionIds.forEach((value, index) => {
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        add(
          violations,
          `transactionIds.${index}`,
          'invalid-format',
          'must be a valid UUID',
        );
      } else {
        const normalized = value.toLowerCase();
        if (seen.has(normalized))
          add(
            violations,
            `transactionIds.${index}`,
            'duplicate',
            'must contain unique UUIDs',
          );
        seen.add(normalized);
        ids.push(normalized);
      }
    });
  }
  let createAdjustment = false;
  if (body.createAdjustment !== undefined) {
    if (typeof body.createAdjustment !== 'boolean')
      add(violations, 'createAdjustment', 'invalid-type', 'must be a boolean');
    else createAdjustment = body.createAdjustment;
  }
  const adjustmentReason = nullableStringValue(
    body.adjustmentReason,
    'adjustmentReason',
    violations,
    500,
  );
  if (violations.length > 0) {
    throw new ReconciliationCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }
  return {
    transactionIds: ids,
    createAdjustment,
    ...(adjustmentReason !== undefined ? { adjustmentReason } : {}),
  };
}
