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
            // int8 is asymmetric: two's complement gives it one more negative
            // value than positive. -9223372036854775808 is a legal bigint, so
            // mirroring the maximum here would refuse a value the column
            // accepts.
            const BIGINT_MIN = -9223372036854775808n;
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
