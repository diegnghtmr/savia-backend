import type { FieldViolation } from '../platform/problem-details.js';
import {
  ACCOUNT_TYPE,
  type AccountType,
  type CreateAccountCommand,
} from './accounts.port.js';

export type { CreateAccountCommand };

const ALLOWED_FIELDS = [
  'name',
  'type',
  'currency',
  'openingBalance',
  'openingBalanceDate',
  'institution',
  'maskedNumber',
  'description',
  'includeInNetWorth',
] as const;

const ACCOUNT_TYPES: readonly string[] = Object.values(ACCOUNT_TYPE);
const ACTIVE_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export class AccountCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Account command validation failed.');
    this.name = 'AccountCommandValidationError';
  }
}

export function createAccountCommand(input: unknown): CreateAccountCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    violations.push(
      Object.freeze({
        field: 'body',
        code: 'invalid-type',
        message: 'must be an object',
      }),
    );
    throw new AccountCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      violations.push(
        Object.freeze({
          field: key,
          code: 'not-allowed',
          message: 'is not allowed',
        }),
      );
    }
  }

  if (body.openingBalance !== undefined) {
    violations.push(
      Object.freeze({
        field: 'openingBalance',
        code: 'unsupported',
        message: 'opening balance is not supported in this slice',
      }),
    );
  }

  if (body.openingBalanceDate !== undefined) {
    violations.push(
      Object.freeze({
        field: 'openingBalanceDate',
        code: 'unsupported',
        message: 'opening balance date is not supported in this slice',
      }),
    );
  }

  let name = '';
  if (typeof body.name !== 'string') {
    violations.push(
      Object.freeze({
        field: 'name',
        code: 'required',
        message: 'must be a non-empty string',
      }),
    );
  } else if (body.name.includes('\0')) {
    violations.push(
      Object.freeze({
        field: 'name',
        code: 'invalid-characters',
        message: 'must not contain null characters',
      }),
    );
  } else {
    const trimmed = body.name.trim();
    if (trimmed.length === 0) {
      violations.push(
        Object.freeze({
          field: 'name',
          code: 'required',
          message: 'must be a non-empty string',
        }),
      );
    } else if ([...trimmed].length > 120) {
      violations.push(
        Object.freeze({
          field: 'name',
          code: 'max-length',
          message: 'must be at most 120 characters',
        }),
      );
    } else {
      name = trimmed;
    }
  }

  let type: AccountType | undefined;
  if (typeof body.type !== 'string') {
    violations.push(
      Object.freeze({
        field: 'type',
        code: 'required',
        message: 'must be a non-empty string',
      }),
    );
  } else if (body.type.includes('\0')) {
    violations.push(
      Object.freeze({
        field: 'type',
        code: 'invalid-characters',
        message: 'must not contain null characters',
      }),
    );
  } else {
    const trimmed = body.type.trim();
    if (trimmed.length === 0) {
      violations.push(
        Object.freeze({
          field: 'type',
          code: 'required',
          message: 'must be a non-empty string',
        }),
      );
    } else if (!ACCOUNT_TYPES.includes(trimmed)) {
      violations.push(
        Object.freeze({
          field: 'type',
          code: 'unsupported',
          message:
            'type must be one of cash, savings, checking, digital_wallet, credit_card, loan, investment_manual, receivable, generic',
        }),
      );
    } else {
      type = trimmed as AccountType;
    }
  }

  let currency = '';
  if (typeof body.currency !== 'string') {
    violations.push(
      Object.freeze({
        field: 'currency',
        code: 'required',
        message: 'must be a non-empty string',
      }),
    );
  } else if (body.currency.includes('\0')) {
    violations.push(
      Object.freeze({
        field: 'currency',
        code: 'invalid-characters',
        message: 'must not contain null characters',
      }),
    );
  } else {
    const trimmed = body.currency.trim().toUpperCase();
    if (trimmed.length === 0) {
      violations.push(
        Object.freeze({
          field: 'currency',
          code: 'required',
          message: 'must be a non-empty string',
        }),
      );
    } else if (!ACTIVE_CURRENCIES.has(trimmed)) {
      violations.push(
        Object.freeze({
          field: 'currency',
          code: 'invalid-currency',
          message: 'must be an active ISO 4217 currency',
        }),
      );
    } else {
      currency = trimmed;
    }
  }

  // CreateAccountRequest declares institution/maskedNumber/description as
  // `type: string` -- NOT nullable. UpdateAccountRequest declares the same three
  // as `type: [string, 'null']`, so the omission on create is deliberate, not an
  // oversight. Treating an explicit null as "absent" would answer 201 for a body
  // the authority forbids, so null falls through to the typeof check below and
  // becomes an invalid-type violation like any other non-string.
  let institution: string | null = null;
  if (body.institution !== undefined) {
    if (typeof body.institution !== 'string') {
      violations.push(
        Object.freeze({
          field: 'institution',
          code: 'invalid-type',
          message: 'must be a string',
        }),
      );
    } else if (body.institution.includes('\0')) {
      violations.push(
        Object.freeze({
          field: 'institution',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        }),
      );
    } else if ([...body.institution].length > 120) {
      violations.push(
        Object.freeze({
          field: 'institution',
          code: 'max-length',
          message: 'must be at most 120 characters',
        }),
      );
    } else {
      institution = body.institution;
    }
  }

  let maskedNumber: string | null = null;
  if (body.maskedNumber !== undefined) {
    if (typeof body.maskedNumber !== 'string') {
      violations.push(
        Object.freeze({
          field: 'maskedNumber',
          code: 'invalid-type',
          message: 'must be a string',
        }),
      );
    } else if (body.maskedNumber.includes('\0')) {
      violations.push(
        Object.freeze({
          field: 'maskedNumber',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        }),
      );
    } else if ([...body.maskedNumber].length > 32) {
      violations.push(
        Object.freeze({
          field: 'maskedNumber',
          code: 'max-length',
          message: 'must be at most 32 characters',
        }),
      );
    } else {
      maskedNumber = body.maskedNumber;
    }
  }

  let description: string | null = null;
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      violations.push(
        Object.freeze({
          field: 'description',
          code: 'invalid-type',
          message: 'must be a string',
        }),
      );
    } else if (body.description.includes('\0')) {
      violations.push(
        Object.freeze({
          field: 'description',
          code: 'invalid-characters',
          message: 'must not contain null characters',
        }),
      );
    } else if ([...body.description].length > 500) {
      violations.push(
        Object.freeze({
          field: 'description',
          code: 'max-length',
          message: 'must be at most 500 characters',
        }),
      );
    } else {
      description = body.description;
    }
  }

  let includeInNetWorth = true;
  if (body.includeInNetWorth !== undefined) {
    if (typeof body.includeInNetWorth !== 'boolean') {
      violations.push(
        Object.freeze({
          field: 'includeInNetWorth',
          code: 'invalid-type',
          message: 'must be a boolean',
        }),
      );
    } else {
      includeInNetWorth = body.includeInNetWorth;
    }
  }

  if (violations.length > 0) {
    violations.sort(
      (left, right) =>
        left.field.localeCompare(right.field) ||
        left.message.localeCompare(right.message),
    );
    throw new AccountCommandValidationError(Object.freeze(violations));
  }

  return Object.freeze({
    name,
    type: type as AccountType,
    currency,
    institution,
    maskedNumber,
    description,
    includeInNetWorth,
  });
}
