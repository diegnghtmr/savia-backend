import type { PageInfo, Cursor } from '../platform/cursor.js';
import type { CreateTransactionCommand } from '../ledger/transaction-command.js';
import type { RecurringBehavior, RecurringFrequency } from './occurrence.js';

export const RECURRING_RULES_PORT = Symbol('RecurringRulesPort');

export interface RecurringRule {
  readonly id: string;
  readonly name: string;
  readonly frequency: RecurringFrequency;
  readonly rrule: string | null;
  readonly behavior: RecurringBehavior;
  readonly template: CreateTransactionCommand;
  readonly active: boolean;
  readonly nextOccurrenceAt: string;
}

export interface CreateRecurringRuleCommand {
  readonly name: string;
  readonly frequency: RecurringFrequency;
  readonly rrule: string | null;
  readonly behavior: RecurringBehavior;
  readonly template: CreateTransactionCommand;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly nextOccurrenceAt: string;
  readonly anchorDayOfMonth: number;
}

export interface RecurringRuleListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export const RECURRING_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  ACCOUNT_NOT_FOUND: 'account_not_found',
  CATEGORY_NOT_FOUND: 'category_not_found',
  PAYEE_NOT_FOUND: 'payee_not_found',
  TAG_NOT_FOUND: 'tag_not_found',
} as const;

export type RecurringCreateOutcomeKind =
  (typeof RECURRING_CREATE_OUTCOMES)[keyof typeof RECURRING_CREATE_OUTCOMES];

export interface RecurringCreateCreated {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.CREATED;
  readonly rule: RecurringRule;
}

export interface RecurringCreateReplayed {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface RecurringCreateIdempotencyConflict {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface RecurringCreateForbidden {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.FORBIDDEN;
}

export interface RecurringCreateAccountNotFound {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND;
}

export interface RecurringCreateCategoryNotFound {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.CATEGORY_NOT_FOUND;
}

export interface RecurringCreatePayeeNotFound {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.PAYEE_NOT_FOUND;
}

export interface RecurringCreateTagNotFound {
  readonly kind: typeof RECURRING_CREATE_OUTCOMES.TAG_NOT_FOUND;
}

export type RecurringCreateOutcome =
  | RecurringCreateCreated
  | RecurringCreateReplayed
  | RecurringCreateIdempotencyConflict
  | RecurringCreateForbidden
  | RecurringCreateAccountNotFound
  | RecurringCreateCategoryNotFound
  | RecurringCreatePayeeNotFound
  | RecurringCreateTagNotFound;

export const RECURRING_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
} as const;

export type RecurringListOutcomeKind =
  (typeof RECURRING_LIST_OUTCOMES)[keyof typeof RECURRING_LIST_OUTCOMES];

export interface RecurringRulePage {
  readonly items: readonly RecurringRule[];
  readonly pageInfo: PageInfo;
}

export interface RecurringListOk {
  readonly kind: typeof RECURRING_LIST_OUTCOMES.OK;
  readonly page: RecurringRulePage;
}

export interface RecurringListForbidden {
  readonly kind: typeof RECURRING_LIST_OUTCOMES.FORBIDDEN;
}

export type RecurringListOutcome = RecurringListOk | RecurringListForbidden;

// --- Subscriptions (Epica 4 Slice 5) ---

export const SUBSCRIPTION_STATUSES = [
  'detected',
  'confirmed',
  'ignored',
  'cancelled',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface SubscriptionAmount {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface Subscription {
  readonly id: string;
  readonly payeeName: string;
  readonly currentAmount: SubscriptionAmount;
  readonly previousAmount?: SubscriptionAmount;
  readonly increasePercent: number | null;
  readonly frequency: string;
  readonly nextExpectedAt: string | null;
  readonly status: SubscriptionStatus;
}

export interface SubscriptionListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
  readonly status?: SubscriptionStatus;
}

export interface SubscriptionPage {
  readonly items: readonly Subscription[];
  readonly pageInfo: PageInfo;
}

export const SUBSCRIPTION_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
} as const;

export type SubscriptionListOutcomeKind =
  (typeof SUBSCRIPTION_LIST_OUTCOMES)[keyof typeof SUBSCRIPTION_LIST_OUTCOMES];

export interface SubscriptionListOk {
  readonly kind: typeof SUBSCRIPTION_LIST_OUTCOMES.OK;
  readonly page: SubscriptionPage;
}

export interface SubscriptionListForbidden {
  readonly kind: typeof SUBSCRIPTION_LIST_OUTCOMES.FORBIDDEN;
}

export type SubscriptionListOutcome =
  | SubscriptionListOk
  | SubscriptionListForbidden;

export interface RecurringRulesPort {
  createRecurringRule(
    subject: string,
    workspaceId: string,
    command: CreateRecurringRuleCommand,
    idempotencyKey: string,
  ): Promise<RecurringCreateOutcome>;

  listRecurringRules(
    subject: string,
    query: RecurringRuleListQuery,
  ): Promise<RecurringListOutcome>;

  listSubscriptions(
    subject: string,
    query: SubscriptionListQuery,
  ): Promise<SubscriptionListOutcome>;
}
