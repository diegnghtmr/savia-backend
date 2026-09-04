import {
  add,
  currencyValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type {
  CreateFundContributionRequest,
  CreateFundRequest,
  Money,
} from './fund.port.js';

export class FundCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Fund command validation failed.');
    this.name = 'FundCommandValidationError';
  }
}

const CREATE_FUND_FIELDS = [
  'name',
  'currency',
  'targetAmount',
  'targetDate',
  'linkedAccountId',
] as const;

const CREATE_CONTRIBUTION_FIELDS = [
  'accountId',
  'amount',
  'occurredAt',
  'notes',
] as const;

const MONEY_FIELDS = ['amountMinor', 'currency'] as const;
const INTEGER_PATTERN = /^-?[0-9]+$/;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_PATTERN.test(v)) {
    return false;
  }
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parseMoney(
  value: unknown,
  field: string,
  violations: FieldViolation[],
  requirePositive = true,
): Money | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add(violations, field, 'invalid-type', 'must be an object');
    return undefined;
  }
  const m = value as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MONEY_FIELDS.includes(key as (typeof MONEY_FIELDS)[number])) {
      add(violations, `${field}.${key}`, 'not-allowed', 'is not allowed');
    }
  }

  let amountMinor: string | undefined;
  if (m.amountMinor === undefined) {
    add(
      violations,
      `${field}.amountMinor`,
      'required',
      'must be a non-empty string',
    );
  } else if (typeof m.amountMinor !== 'string') {
    add(violations, `${field}.amountMinor`, 'invalid-type', 'must be a string');
  } else if (m.amountMinor.includes('\0')) {
    add(
      violations,
      `${field}.amountMinor`,
      'invalid-characters',
      'must not contain null characters',
    );
  } else {
    const trimmed = m.amountMinor.trim();
    if (!trimmed) {
      add(
        violations,
        `${field}.amountMinor`,
        'required',
        'must be a non-empty string',
      );
    } else if (!INTEGER_PATTERN.test(trimmed)) {
      add(
        violations,
        `${field}.amountMinor`,
        'invalid-format',
        'must be an integer minor-unit amount string',
      );
    } else {
      try {
        const val = BigInt(trimmed);
        if (val < INT64_MIN || val > INT64_MAX) {
          add(
            violations,
            `${field}.amountMinor`,
            'invalid-range',
            'must be within 64-bit signed integer range',
          );
        } else if (requirePositive && val <= 0n) {
          add(
            violations,
            `${field}.amountMinor`,
            'invalid-range',
            'must be greater than zero',
          );
        } else {
          amountMinor = trimmed;
        }
      } catch {
        add(
          violations,
          `${field}.amountMinor`,
          'invalid-range',
          'must be within 64-bit signed integer range',
        );
      }
    }
  }

  const currency = currencyValue(m.currency, `${field}.currency`, violations);

  if (amountMinor !== undefined && currency) {
    return {
      amountMinor,
      currency,
    };
  }
  return undefined;
}

export function createFundCommand(input: unknown): CreateFundRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new FundCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !CREATE_FUND_FIELDS.includes(key as (typeof CREATE_FUND_FIELDS)[number])
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let name = '';
  if (body.name === undefined) {
    add(violations, 'name', 'required', 'must be a non-empty string');
  } else if (typeof body.name !== 'string') {
    add(violations, 'name', 'invalid-type', 'must be a string');
  } else if (body.name.includes('\0')) {
    add(
      violations,
      'name',
      'invalid-characters',
      'must not contain null characters',
    );
  } else {
    const trimmed = body.name.trim();
    if (!trimmed) {
      add(violations, 'name', 'required', 'must be a non-empty string');
    } else if ([...trimmed].length > 120) {
      add(violations, 'name', 'max-length', 'must be at most 120 characters');
    } else {
      name = trimmed;
    }
  }

  const currency = currencyValue(body.currency, 'currency', violations);
  const targetAmount = parseMoney(
    body.targetAmount,
    'targetAmount',
    violations,
    true,
  );

  if (
    targetAmount !== undefined &&
    currency &&
    targetAmount.currency !== currency
  ) {
    add(
      violations,
      'targetAmount.currency',
      'invalid',
      'must match fund currency',
    );
  }

  let targetDate: string | null = null;
  if (body.targetDate !== undefined && body.targetDate !== null) {
    if (typeof body.targetDate !== 'string') {
      add(violations, 'targetDate', 'invalid-type', 'must be a string or null');
    } else if (!validDate(body.targetDate)) {
      add(
        violations,
        'targetDate',
        'invalid-format',
        'must be a valid UTC calendar date (YYYY-MM-DD)',
      );
    } else {
      targetDate = body.targetDate;
    }
  }

  let linkedAccountId: string | null = null;
  if (body.linkedAccountId !== undefined && body.linkedAccountId !== null) {
    if (typeof body.linkedAccountId !== 'string') {
      add(
        violations,
        'linkedAccountId',
        'invalid-type',
        'must be a string or null',
      );
    } else if (!UUID_PATTERN.test(body.linkedAccountId.trim())) {
      add(
        violations,
        'linkedAccountId',
        'invalid-format',
        'must be a valid UUID',
      );
    } else {
      linkedAccountId = body.linkedAccountId.trim().toLowerCase();
    }
  }

  if (violations.length > 0) {
    throw new FundCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    name,
    currency,
    targetAmount: targetAmount!,
    targetDate,
    linkedAccountId,
  };
}

export function createFundContributionCommand(
  input: unknown,
): CreateFundContributionRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new FundCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !CREATE_CONTRIBUTION_FIELDS.includes(
        key as (typeof CREATE_CONTRIBUTION_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let accountId = '';
  if (body.accountId === undefined) {
    add(violations, 'accountId', 'required', 'must be a valid UUID');
  } else if (typeof body.accountId !== 'string') {
    add(violations, 'accountId', 'invalid-type', 'must be a string');
  } else if (!UUID_PATTERN.test(body.accountId.trim())) {
    add(violations, 'accountId', 'invalid-format', 'must be a valid UUID');
  } else {
    accountId = body.accountId.trim().toLowerCase();
  }

  const amount = parseMoney(body.amount, 'amount', violations, true);

  let occurredAt = '';
  if (body.occurredAt === undefined) {
    add(violations, 'occurredAt', 'required', 'must be a non-empty string');
  } else if (typeof body.occurredAt !== 'string') {
    add(violations, 'occurredAt', 'invalid-type', 'must be a string');
  } else {
    const trimmed = body.occurredAt.trim();
    if (!trimmed || !ISO_DATE_TIME_PATTERN.test(trimmed)) {
      add(
        violations,
        'occurredAt',
        'invalid-date',
        'must be a valid ISO 8601 date-time string',
      );
    } else {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        add(
          violations,
          'occurredAt',
          'invalid-date',
          'must be a valid ISO 8601 date-time string',
        );
      } else {
        occurredAt = trimmed;
      }
    }
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      add(violations, 'notes', 'invalid-type', 'must be a string or null');
    } else if (body.notes.includes('\0')) {
      add(
        violations,
        'notes',
        'invalid-characters',
        'must not contain null characters',
      );
    } else if ([...body.notes].length > 500) {
      add(violations, 'notes', 'max-length', 'must be at most 500 characters');
    } else {
      notes = body.notes;
    }
  }

  if (violations.length > 0) {
    throw new FundCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    accountId,
    amount: amount!,
    occurredAt,
    notes,
  };
}
