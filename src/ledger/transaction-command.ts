import {
  add,
  currencyValue,
  enumValue,
  nullableStringValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  TRANSACTION_TYPE,
  type CreateTransactionCommand,
  type TransactionType,
  type UpdateTransactionCommand,
} from './ledger.port.js';
import { ensureNoSplits } from './splits-guard.js';

export type { CreateTransactionCommand, UpdateTransactionCommand };

const ALLOWED_FIELDS = [
  'type',
  'accountId',
  'amount',
  'occurredAt',
  'status',
  'categoryId',
  'payeeId',
  'description',
  'notes',
  'tagIds',
  'splits',
  'receiptId',
] as const;

const TRANSACTION_TYPES: readonly string[] = Object.values(TRANSACTION_TYPE);
const CREATE_STATUSES = ['draft', 'pending', 'confirmed'] as const;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const BIGINT_MIN = -9223372036854775807n;
const BIGINT_MAX = 9223372036854775807n;

export class TransactionCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Transaction command validation failed.');
    this.name = 'TransactionCommandValidationError';
  }
}

export function createTransactionCommand(
  input: unknown,
): CreateTransactionCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new TransactionCommandValidationError(Object.freeze(violations));
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key as (typeof ALLOWED_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  // Splits guard: non-empty splits array is refused with dedicated 422 error
  if ('splits' in body && body.splits !== undefined) {
    if (!Array.isArray(body.splits)) {
      add(violations, 'splits', 'invalid-type', 'must be an array');
    } else {
      ensureNoSplits(body.splits);
    }
  }

  const type = enumValue(
    body.type,
    'type',
    TRANSACTION_TYPES,
    violations,
    'type must be one of income, expense, adjustment, refund, debt_payment, fund_contribution',
  ) as TransactionType;

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

  let amount: CreateTransactionCommand['amount'] = {
    amountMinor: '',
    currency: '',
  };

  if (body.amount === undefined) {
    add(violations, 'amount', 'required', 'must be an object');
  } else if (
    typeof body.amount !== 'object' ||
    body.amount === null ||
    Array.isArray(body.amount)
  ) {
    add(violations, 'amount', 'invalid-type', 'must be an object');
  } else {
    const amt = body.amount as Record<string, unknown>;
    const ALLOWED_AMOUNT_KEYS = ['amountMinor', 'currency'] as const;
    for (const key of Object.keys(amt)) {
      if (
        !ALLOWED_AMOUNT_KEYS.includes(
          key as (typeof ALLOWED_AMOUNT_KEYS)[number],
        )
      ) {
        add(violations, `amount.${key}`, 'not-allowed', 'is not allowed');
      }
    }

    let validatedAmountMinor: string | undefined;
    if (amt.amountMinor === undefined) {
      add(
        violations,
        'amount.amountMinor',
        'required',
        'must be a non-empty string',
      );
    } else if (typeof amt.amountMinor !== 'string') {
      add(violations, 'amount.amountMinor', 'invalid-type', 'must be a string');
    } else if (amt.amountMinor.includes('\0')) {
      add(
        violations,
        'amount.amountMinor',
        'invalid-characters',
        'must not contain null characters',
      );
    } else {
      const trimmed = amt.amountMinor.trim();
      if (!trimmed) {
        add(
          violations,
          'amount.amountMinor',
          'required',
          'must be a non-empty string',
        );
      } else if (!/^-?[0-9]+$/.test(trimmed)) {
        add(
          violations,
          'amount.amountMinor',
          'invalid-format',
          'must be an integer minor-unit amount string',
        );
      } else {
        try {
          const val = BigInt(trimmed);
          if (val < BIGINT_MIN || val > BIGINT_MAX) {
            add(
              violations,
              'amount.amountMinor',
              'invalid-range',
              'must be within 64-bit signed integer range',
            );
          } else {
            validatedAmountMinor = trimmed;
          }
        } catch {
          add(
            violations,
            'amount.amountMinor',
            'invalid-range',
            'must be within 64-bit signed integer range',
          );
        }
      }
    }

    let validatedCurrency: string | undefined;
    if (amt.currency === undefined) {
      add(
        violations,
        'amount.currency',
        'required',
        'must be a non-empty string',
      );
    } else {
      const cur = currencyValue(amt.currency, 'amount.currency', violations);
      if (cur) {
        validatedCurrency = cur;
      }
    }

    if (validatedAmountMinor !== undefined && validatedCurrency !== undefined) {
      amount = Object.freeze({
        amountMinor: validatedAmountMinor,
        currency: validatedCurrency,
      });
    }
  }

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

  let status: 'draft' | 'pending' | 'confirmed' = 'confirmed';
  if ('status' in body && body.status !== undefined) {
    status = enumValue(
      body.status,
      'status',
      CREATE_STATUSES,
      violations,
      'status must be one of draft, pending, confirmed',
    ) as 'draft' | 'pending' | 'confirmed';
  }

  let categoryId: string | null = null;
  if (
    'categoryId' in body &&
    body.categoryId !== undefined &&
    body.categoryId !== null
  ) {
    if (
      typeof body.categoryId !== 'string' ||
      !UUID_PATTERN.test(body.categoryId)
    ) {
      add(violations, 'categoryId', 'invalid-format', 'must be a valid UUID');
    } else {
      categoryId = body.categoryId;
    }
  }

  let payeeId: string | null = null;
  if (
    'payeeId' in body &&
    body.payeeId !== undefined &&
    body.payeeId !== null
  ) {
    if (typeof body.payeeId !== 'string' || !UUID_PATTERN.test(body.payeeId)) {
      add(violations, 'payeeId', 'invalid-format', 'must be a valid UUID');
    } else {
      payeeId = body.payeeId;
    }
  }

  let receiptId: string | null = null;
  if (
    'receiptId' in body &&
    body.receiptId !== undefined &&
    body.receiptId !== null
  ) {
    if (
      typeof body.receiptId !== 'string' ||
      !UUID_PATTERN.test(body.receiptId)
    ) {
      add(violations, 'receiptId', 'invalid-format', 'must be a valid UUID');
    } else {
      receiptId = body.receiptId;
    }
  }

  const description = nullableStringValue(
    body.description,
    'description',
    violations,
    500,
  );
  const notes = nullableStringValue(body.notes, 'notes', violations, 2000);

  let tagIds: string[] = [];
  if ('tagIds' in body && body.tagIds !== undefined) {
    if (!Array.isArray(body.tagIds)) {
      add(violations, 'tagIds', 'invalid-type', 'must be an array');
    } else {
      const seen = new Set<string>();
      let hasDuplicates = false;
      let allValidUuids = true;

      for (const tag of body.tagIds) {
        if (typeof tag !== 'string' || !UUID_PATTERN.test(tag)) {
          allValidUuids = false;
        } else {
          if (seen.has(tag)) {
            hasDuplicates = true;
          }
          seen.add(tag);
        }
      }

      if (!allValidUuids) {
        add(
          violations,
          'tagIds',
          'invalid-format',
          'must be an array of valid UUIDs',
        );
      }
      if (hasDuplicates) {
        add(
          violations,
          'tagIds',
          'duplicate-values',
          'tagIds must contain unique values',
        );
      }

      if (allValidUuids && !hasDuplicates) {
        tagIds = body.tagIds as string[];
      }
    }
  }

  if (violations.length > 0) {
    throw new TransactionCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return Object.freeze({
    type,
    accountId,
    amount,
    occurredAt,
    status,
    categoryId,
    payeeId,
    description,
    notes,
    tagIds: Object.freeze(tagIds),
    receiptId,
  });
}

const UPDATE_ALLOWED_FIELDS = [
  'occurredAt',
  'categoryId',
  'payeeId',
  'description',
  'notes',
  'tagIds',
  'splits',
  'status',
] as const;

const UPDATE_STATUSES = ['draft', 'pending', 'confirmed'] as const;

export function createUpdateTransactionCommand(
  input: unknown,
): UpdateTransactionCommand {
  const violations: FieldViolation[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new TransactionCommandValidationError(Object.freeze(violations));
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

  // Splits guard: non-empty splits array is refused with dedicated 422 error
  if ('splits' in body && body.splits !== undefined) {
    if (!Array.isArray(body.splits)) {
      add(violations, 'splits', 'invalid-type', 'must be an array');
    } else {
      ensureNoSplits(body.splits);
    }
  }

  const command: {
    occurredAt?: string;
    categoryId?: string | null;
    payeeId?: string | null;
    description?: string | null;
    notes?: string | null;
    tagIds?: readonly string[];
    status?: 'draft' | 'pending' | 'confirmed';
  } = {};

  if ('occurredAt' in body) {
    if (body.occurredAt === undefined || typeof body.occurredAt !== 'string') {
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
          command.occurredAt = trimmed;
        }
      }
    }
  }

  if ('categoryId' in body) {
    if (body.categoryId === null) {
      command.categoryId = null;
    } else if (typeof body.categoryId !== 'string') {
      add(violations, 'categoryId', 'invalid-type', 'must be a string or null');
    } else if (!UUID_PATTERN.test(body.categoryId)) {
      add(violations, 'categoryId', 'invalid-format', 'must be a valid UUID');
    } else {
      command.categoryId = body.categoryId;
    }
  }

  if ('payeeId' in body) {
    if (body.payeeId === null) {
      command.payeeId = null;
    } else if (typeof body.payeeId !== 'string') {
      add(violations, 'payeeId', 'invalid-type', 'must be a string or null');
    } else if (!UUID_PATTERN.test(body.payeeId)) {
      add(violations, 'payeeId', 'invalid-format', 'must be a valid UUID');
    } else {
      command.payeeId = body.payeeId;
    }
  }

  if ('description' in body) {
    command.description = nullableStringValue(
      body.description,
      'description',
      violations,
      500,
    );
  }

  if ('notes' in body) {
    command.notes = nullableStringValue(body.notes, 'notes', violations, 2000);
  }

  if ('tagIds' in body) {
    if (body.tagIds === undefined) {
      // do not populate
    } else if (!Array.isArray(body.tagIds)) {
      add(violations, 'tagIds', 'invalid-type', 'must be an array');
    } else {
      const seen = new Set<string>();
      let hasDuplicates = false;
      let allValidUuids = true;

      for (const tag of body.tagIds) {
        if (typeof tag !== 'string' || !UUID_PATTERN.test(tag)) {
          allValidUuids = false;
        } else {
          if (seen.has(tag)) {
            hasDuplicates = true;
          }
          seen.add(tag);
        }
      }

      if (!allValidUuids) {
        add(
          violations,
          'tagIds',
          'invalid-format',
          'must be an array of valid UUIDs',
        );
      }
      if (hasDuplicates) {
        add(
          violations,
          'tagIds',
          'duplicate-values',
          'tagIds must contain unique values',
        );
      }

      if (allValidUuids && !hasDuplicates) {
        command.tagIds = Object.freeze([...body.tagIds]);
      }
    }
  }

  if ('status' in body) {
    command.status = enumValue(
      body.status,
      'status',
      UPDATE_STATUSES,
      violations,
      'status must be one of draft, pending, confirmed',
    ) as 'draft' | 'pending' | 'confirmed';
  }

  if (violations.length > 0) {
    throw new TransactionCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return Object.freeze(command);
}
