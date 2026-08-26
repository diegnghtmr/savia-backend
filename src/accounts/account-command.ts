import {
  add,
  currencyValue,
  enumValue,
  nameValue,
  nullableStringValue,
  optionalBooleanValue,
  optionalStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import {
  ACCOUNT_TYPE,
  type AccountType,
  type CreateAccountCommand,
  type UpdateAccountCommand,
} from './accounts.port.js';

export type { CreateAccountCommand, UpdateAccountCommand };

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

  const name = nameValue(body.name, 'name', violations);
  const type = enumValue(
    body.type,
    'type',
    ACCOUNT_TYPES,
    violations,
    'type must be one of cash, savings, checking, digital_wallet, credit_card, loan, investment_manual, receivable, generic',
  ) as AccountType;
  const currency = currencyValue(body.currency, 'currency', violations);

  let openingBalance: CreateAccountCommand['openingBalance'] = undefined;
  let openingBalanceDate: string | null | undefined = undefined;

  if (body.openingBalance !== undefined) {
    if (
      typeof body.openingBalance !== 'object' ||
      body.openingBalance === null ||
      Array.isArray(body.openingBalance)
    ) {
      add(violations, 'openingBalance', 'invalid-type', 'must be an object');
    } else {
      const ob = body.openingBalance as Record<string, unknown>;
      const ALLOWED_MONEY_KEYS = ['amountMinor', 'currency'] as const;
      for (const key of Object.keys(ob)) {
        if (
          !ALLOWED_MONEY_KEYS.includes(
            key as (typeof ALLOWED_MONEY_KEYS)[number],
          )
        ) {
          add(
            violations,
            `openingBalance.${key}`,
            'not-allowed',
            'is not allowed',
          );
        }
      }

      let validatedAmountMinor: string | undefined;
      if (ob.amountMinor === undefined) {
        add(
          violations,
          'openingBalance.amountMinor',
          'required',
          'must be a non-empty string',
        );
      } else if (typeof ob.amountMinor !== 'string') {
        add(
          violations,
          'openingBalance.amountMinor',
          'invalid-type',
          'must be a string',
        );
      } else if (ob.amountMinor.includes('\0')) {
        add(
          violations,
          'openingBalance.amountMinor',
          'invalid-characters',
          'must not contain null characters',
        );
      } else {
        const trimmed = ob.amountMinor.trim();
        if (!trimmed) {
          add(
            violations,
            'openingBalance.amountMinor',
            'required',
            'must be a non-empty string',
          );
        } else if (!/^-?[0-9]+$/.test(trimmed)) {
          add(
            violations,
            'openingBalance.amountMinor',
            'invalid-format',
            'must be an integer minor-unit amount string',
          );
        } else {
          try {
            const val = BigInt(trimmed);
            // The bound is NOT the column's range. int8 is asymmetric --
            // -9223372036854775808 is a legal bigint -- but an opening balance
            // is written as a BALANCED PAIR, and the external counter-leg
            // carries the negation. Negating int64-min yields
            // 9223372036854775808, one past int8 max, which PostgreSQL refuses
            // with 22003 at insert time. Accepting it would mean validation
            // promising what storage can never honour: a 500 after a 201-shaped
            // promise. The admissible range is therefore the one closed under
            // negation, which is symmetric.
            const BIGINT_MIN = -9223372036854775807n;
            const BIGINT_MAX = 9223372036854775807n;
            if (val < BIGINT_MIN || val > BIGINT_MAX) {
              add(
                violations,
                'openingBalance.amountMinor',
                'invalid-range',
                'must be within 64-bit signed integer range',
              );
            } else {
              validatedAmountMinor = trimmed;
            }
          } catch {
            add(
              violations,
              'openingBalance.amountMinor',
              'invalid-range',
              'must be within 64-bit signed integer range',
            );
          }
        }
      }

      let validatedObCurrency: string | undefined;
      if (ob.currency === undefined) {
        add(
          violations,
          'openingBalance.currency',
          'required',
          'must be a non-empty string',
        );
      } else {
        const obCur = currencyValue(
          ob.currency,
          'openingBalance.currency',
          violations,
        );
        if (obCur) {
          validatedObCurrency = obCur;
        }
      }

      if (validatedObCurrency && currency && validatedObCurrency !== currency) {
        add(
          violations,
          'openingBalance.currency',
          'currency-mismatch',
          'opening balance currency must match account currency',
        );
      }

      if (
        validatedAmountMinor !== undefined &&
        validatedObCurrency !== undefined
      ) {
        openingBalance = Object.freeze({
          amountMinor: validatedAmountMinor,
          currency: validatedObCurrency,
        });
      }
    }
  }

  if (body.openingBalanceDate !== undefined) {
    if (body.openingBalance === undefined) {
      add(
        violations,
        'openingBalanceDate',
        'not-allowed',
        'cannot be provided without openingBalance',
      );
    } else if (typeof body.openingBalanceDate !== 'string') {
      add(violations, 'openingBalanceDate', 'invalid-type', 'must be a string');
    } else {
      const dateStr = body.openingBalanceDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        add(
          violations,
          'openingBalanceDate',
          'invalid-date',
          'must be a valid calendar date in YYYY-MM-DD format',
        );
      } else {
        const [yStr, mStr, dStr] = dateStr.split('-');
        const y = Number(yStr);
        const m = Number(mStr);
        const d = Number(dStr);
        const parsed = new Date(`${dateStr}T00:00:00.000Z`);
        if (
          Number.isNaN(parsed.getTime()) ||
          parsed.getUTCFullYear() !== y ||
          parsed.getUTCMonth() + 1 !== m ||
          parsed.getUTCDate() !== d
        ) {
          add(
            violations,
            'openingBalanceDate',
            'invalid-date',
            'must be a valid calendar date in YYYY-MM-DD format',
          );
        } else {
          openingBalanceDate = dateStr;
        }
      }
    }
  } else if (body.openingBalance !== undefined) {
    openingBalanceDate = null;
  }

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
    ...(openingBalance !== undefined ? { openingBalance } : {}),
    ...(openingBalanceDate !== undefined ? { openingBalanceDate } : {}),
    institution,
    maskedNumber,
    description,
    includeInNetWorth,
  });
}

const UPDATE_ALLOWED_FIELDS = [
  'name',
  'institution',
  'maskedNumber',
  'description',
  'includeInNetWorth',
  'status',
] as const;

const UPDATE_ACCOUNT_STATUSES = ['active', 'archived'] as const;

export function createUpdateAccountCommand(
  input: unknown,
): UpdateAccountCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new AccountCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);

  if (keys.length === 0) {
    add(
      violations,
      'body',
      'empty-update',
      'must contain at least one field to update',
    );
  }

  for (const key of keys) {
    if (
      !UPDATE_ALLOWED_FIELDS.includes(
        key as (typeof UPDATE_ALLOWED_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  const command: {
    name?: string;
    institution?: string | null;
    maskedNumber?: string | null;
    description?: string | null;
    includeInNetWorth?: boolean;
    status?: 'active' | 'archived';
  } = {};

  if ('name' in body) {
    command.name = nameValue(body.name, 'name', violations);
  }

  if ('institution' in body) {
    command.institution = nullableStringValue(
      body.institution,
      'institution',
      violations,
      120,
    );
  }

  if ('maskedNumber' in body) {
    command.maskedNumber = nullableStringValue(
      body.maskedNumber,
      'maskedNumber',
      violations,
      32,
    );
  }

  if ('description' in body) {
    command.description = nullableStringValue(
      body.description,
      'description',
      violations,
      500,
    );
  }

  if ('includeInNetWorth' in body) {
    if (typeof body.includeInNetWorth !== 'boolean') {
      add(
        violations,
        'includeInNetWorth',
        'invalid-type',
        'must be a boolean',
      );
    } else {
      command.includeInNetWorth = body.includeInNetWorth;
    }
  }

  if ('status' in body) {
    command.status = enumValue(
      body.status,
      'status',
      UPDATE_ACCOUNT_STATUSES,
      violations,
      'status must be one of active, archived',
    );
  }

  if (violations.length > 0) {
    throw new AccountCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return Object.freeze(command);
}

