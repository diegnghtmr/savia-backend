import {
  ACTIVE_CURRENCIES,
  nullableStringValue,
} from '../platform/field-validation.js';
import type {
  CreateTransactionCommand,
  Money,
} from '../platform/ledger-writer.port.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { daysInMonth } from './occurrence.js';

export type TemplateChanges = Partial<
  Pick<CreateTransactionCommand, 'amount' | 'description' | 'categoryId'>
>;
export type OccurrenceEdit =
  | { readonly action: 'reschedule'; readonly scheduledAt: string }
  | { readonly action: 'edit-one'; readonly changes: TemplateChanges }
  | {
      readonly action: 'edit-series';
      readonly effectiveFrom: string;
      readonly changes: TemplateChanges;
    };

function object(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function hasOnly(
  body: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(body).every((key) => fields.includes(key));
}

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d+))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DATE_TIME.exec(value);
  if (!match) return undefined;
  const [, year, month, day, , fraction = ''] = match;
  if (
    Number(year) < 1 ||
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth(Number(year), Number(month) - 1)
  )
    return undefined;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  const utc = new Date(millis).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith('0000-')) return undefined;
  const micros = fraction.slice(3, 6).padEnd(3, '0');
  return micros === '000' ? utc : `${utc.slice(0, -1)}${micros}Z`;
}

function money(input: unknown): Money | undefined {
  const body = object(input);
  if (!body || !hasOnly(body, ['amountMinor', 'currency'])) return undefined;
  const { amountMinor, currency } = body;
  if (
    typeof amountMinor !== 'string' ||
    !/^\d+$/.test(amountMinor) ||
    typeof currency !== 'string' ||
    !ACTIVE_CURRENCIES.has(currency)
  )
    return undefined;
  const normalized = amountMinor.replace(/^0+/, '');
  if (
    !normalized ||
    normalized.length > 19 ||
    BigInt(normalized) > 9223372036854775807n
  )
    return undefined;
  return { amountMinor: normalized, currency };
}

function templateChanges(input: unknown): TemplateChanges | undefined {
  const body = object(input);
  if (
    !body ||
    Object.keys(body).length === 0 ||
    !hasOnly(body, ['amount', 'description', 'categoryId'])
  )
    return undefined;
  const amount = 'amount' in body ? money(body.amount) : undefined;
  if ('amount' in body && !amount) return undefined;
  const errors: Parameters<typeof nullableStringValue>[2] = [];
  const description = nullableStringValue(
    body.description,
    'description',
    errors,
    500,
  );
  const { categoryId } = body;
  if (
    errors.length ||
    (categoryId !== undefined &&
      categoryId !== null &&
      (typeof categoryId !== 'string' || !UUID_PATTERN.test(categoryId)))
  )
    return undefined;
  const category =
    typeof categoryId === 'string' ? categoryId.toLowerCase() : null;
  return {
    ...(amount && { amount }),
    ...('description' in body && { description }),
    ...('categoryId' in body && { categoryId: category }),
  };
}

export function parseOccurrenceEdit(
  action: OccurrenceEdit['action'],
  input: unknown,
): OccurrenceEdit | undefined {
  const body = object(input);
  if (!body) return undefined;
  switch (action) {
    case 'reschedule': {
      const scheduledAt = timestamp(body.scheduledAt);
      return scheduledAt && hasOnly(body, ['scheduledAt'])
        ? { action, scheduledAt }
        : undefined;
    }
    case 'edit-one': {
      const changes = templateChanges(body);
      return changes && { action, changes };
    }
    case 'edit-series': {
      const effectiveFrom = timestamp(body.effectiveFrom);
      const changes = templateChanges(body.changes);
      if (!hasOnly(body, ['effectiveFrom', 'changes'])) return undefined;
      if (!effectiveFrom || !changes) return undefined;
      return { action, effectiveFrom, changes };
    }
  }
}
