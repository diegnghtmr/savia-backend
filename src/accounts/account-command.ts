import {
  add,
  currencyValue,
  enumValue,
  nameValue,
  optionalBooleanValue,
  optionalStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
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

export class AccountCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Account command validation failed.');
    this.name = 'AccountCommandValidationError';
  }
}

export function createAccountCommand(input: unknown): CreateAccountCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new AccountCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  if (body.openingBalance !== undefined) {
    add(
      violations,
      'openingBalance',
      'unsupported',
      'opening balance is not supported in this slice',
    );
  }

  if (body.openingBalanceDate !== undefined) {
    add(
      violations,
      'openingBalanceDate',
      'unsupported',
      'opening balance date is not supported in this slice',
    );
  }

  const name = nameValue(body.name, 'name', violations);
  const type = enumValue(
    body.type,
    'type',
    ACCOUNT_TYPES,
    violations,
    'type must be one of cash, savings, checking, digital_wallet, credit_card, loan, investment_manual, receivable, generic',
  ) as AccountType;
  const currency = currencyValue(body.currency, 'currency', violations);

  const institution = optionalStringValue(
    body.institution,
    'institution',
    violations,
    120,
  );
  const maskedNumber = optionalStringValue(
    body.maskedNumber,
    'maskedNumber',
    violations,
    32,
  );
  const description = optionalStringValue(
    body.description,
    'description',
    violations,
    500,
  );
  const includeInNetWorth = optionalBooleanValue(
    body.includeInNetWorth,
    'includeInNetWorth',
    violations,
    true,
  );

  if (violations.length > 0) {
    throw new AccountCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return Object.freeze({
    name,
    type,
    currency,
    institution,
    maskedNumber,
    description,
    includeInNetWorth,
  });
}
