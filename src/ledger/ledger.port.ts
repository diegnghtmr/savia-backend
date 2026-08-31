import type { Cursor, PageInfo } from '../platform/cursor.js';

export const LEDGER_PORT = Symbol('LedgerPort');

export const TRANSACTION_TYPE = {
  INCOME: 'income',
  EXPENSE: 'expense',
  ADJUSTMENT: 'adjustment',
  REFUND: 'refund',
  DEBT_PAYMENT: 'debt_payment',
  FUND_CONTRIBUTION: 'fund_contribution',
} as const;
export type TransactionType =
  (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];

export const TRANSACTION_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  RECONCILED: 'reconciled',
  VOIDED: 'voided',
} as const;
export type TransactionStatus =
  (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

const TRANSACTION_STATUS_VALUES: readonly string[] =
  Object.values(TRANSACTION_STATUS);

export function isTransactionStatus(value: string): value is TransactionStatus {
  return TRANSACTION_STATUS_VALUES.includes(value);
}

export const TRANSACTION_SOURCE = {
  WEB: 'web',
  MOBILE: 'mobile',
  CLI: 'cli',
  MCP: 'mcp',
  AGENT: 'agent',
  IMPORT: 'import',
  SYSTEM: 'system',
} as const;
export type TransactionSource =
  (typeof TRANSACTION_SOURCE)[keyof typeof TRANSACTION_SOURCE];

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface ConvertedMoney {
  readonly original: Money;
  readonly converted: Money;
  readonly rate: string;
  readonly rateDate: string;
  readonly rateSource: string;
}

export interface TransactionSplit {
  readonly amount: Money;
  readonly categoryId: string;
  readonly notes?: string | null;
  readonly tagIds?: readonly string[];
}

export interface Transaction {
  readonly id: string;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  readonly accountId: string;
  readonly amount: Money;
  readonly baseCurrencyAmount?: ConvertedMoney;
  readonly occurredAt: string;
  readonly categoryId: string | null;
  readonly payeeId: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly tagIds: readonly string[];
  readonly splits?: readonly TransactionSplit[];
  readonly source?: TransactionSource;
  readonly receiptId: string | null;
  readonly reconciliationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CreateTransactionCommand {
  readonly type: TransactionType;
  readonly accountId: string;
  readonly amount: Money;
  readonly occurredAt: string;
  readonly status: 'draft' | 'pending' | 'confirmed';
  readonly categoryId?: string | null;
  readonly payeeId?: string | null;
  readonly description?: string | null;
  readonly notes?: string | null;
  readonly tagIds?: readonly string[];
  readonly receiptId?: string | null;
}

export const TRANSACTION_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  ACCOUNT_UNRESOLVED: 'account_unresolved',
  ACCOUNT_CLOSED: 'account_closed',
  CATEGORY_NOT_FOUND: 'category_not_found',
  PAYEE_NOT_FOUND: 'payee_not_found',
} as const;
export type TransactionCreateOutcomeKind =
  (typeof TRANSACTION_CREATE_OUTCOMES)[keyof typeof TRANSACTION_CREATE_OUTCOMES];

export interface TransactionCreateCreated {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.CREATED;
  readonly transaction: Transaction;
}

export interface TransactionCreateReplayed {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface TransactionCreateIdempotencyConflict {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface TransactionCreateForbidden {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.FORBIDDEN;
}

export interface TransactionCreateAccountUnresolved {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED;
}

export interface TransactionCreateAccountClosed {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED;
}

export interface TransactionCreateCategoryNotFound {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.CATEGORY_NOT_FOUND;
}

export interface TransactionCreatePayeeNotFound {
  readonly kind: typeof TRANSACTION_CREATE_OUTCOMES.PAYEE_NOT_FOUND;
}

export type TransactionCreateOutcome =
  | TransactionCreateCreated
  | TransactionCreateReplayed
  | TransactionCreateIdempotencyConflict
  | TransactionCreateForbidden
  | TransactionCreateAccountUnresolved
  | TransactionCreateAccountClosed
  | TransactionCreateCategoryNotFound
  | TransactionCreatePayeeNotFound;

export const TRANSACTION_READ_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
} as const;
export type TransactionReadOutcomeKind =
  (typeof TRANSACTION_READ_OUTCOMES)[keyof typeof TRANSACTION_READ_OUTCOMES];

export interface TransactionReadOk {
  readonly kind: typeof TRANSACTION_READ_OUTCOMES.OK;
  readonly transaction: Transaction;
}

export interface TransactionReadForbidden {
  readonly kind: typeof TRANSACTION_READ_OUTCOMES.FORBIDDEN;
}

export interface TransactionReadNotFound {
  readonly kind: typeof TRANSACTION_READ_OUTCOMES.NOT_FOUND;
}

// getTransaction declares 200, 401, 403 and 404 in the authority:
// - 403 when the caller has no active role in the workspace (or workspace is absent)
// - 404 when the transaction does not exist or belongs to another workspace (scoped SQL predicate)
export type TransactionReadOutcome =
  | TransactionReadOk
  | TransactionReadForbidden
  | TransactionReadNotFound;

export type TransactionCursor = Cursor;

export interface TransactionPage {
  readonly items: readonly Transaction[];
  readonly pageInfo: PageInfo;
}

export const TRANSACTION_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
} as const;
export type TransactionListOutcomeKind =
  (typeof TRANSACTION_LIST_OUTCOMES)[keyof typeof TRANSACTION_LIST_OUTCOMES];

export interface TransactionListOk {
  readonly kind: typeof TRANSACTION_LIST_OUTCOMES.OK;
  readonly page: TransactionPage;
}

export interface TransactionListForbidden {
  readonly kind: typeof TRANSACTION_LIST_OUTCOMES.FORBIDDEN;
}

// listTransactions declares 200, 401 and 403 in the authority only:
// - 403 when the caller has no active role in the workspace (or workspace is absent)
export type TransactionListOutcome =
  | TransactionListOk
  | TransactionListForbidden;

export interface TransactionListQuery {
  readonly workspaceId: string;
  readonly cursor?: TransactionCursor;
  readonly limit: number;
  readonly accountId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly categoryId?: string;
  readonly status?: TransactionStatus;
  readonly query?: string;
}

export interface UpdateTransactionCommand {
  readonly occurredAt?: string;
  readonly categoryId?: string | null;
  readonly payeeId?: string | null;
  readonly description?: string | null;
  readonly notes?: string | null;
  readonly tagIds?: readonly string[];
  readonly splits?: readonly TransactionSplit[];
  readonly status?: 'draft' | 'pending' | 'confirmed';
}

export const TRANSACTION_UPDATE_OUTCOMES = {
  OK: 'ok',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VERSION_CONFLICT: 'version_conflict',
  VOIDED: 'voided',
  RECONCILED: 'reconciled',
  CATEGORY_NOT_FOUND: 'category_not_found',
  PAYEE_NOT_FOUND: 'payee_not_found',
} as const;
export type TransactionUpdateOutcomeKind =
  (typeof TRANSACTION_UPDATE_OUTCOMES)[keyof typeof TRANSACTION_UPDATE_OUTCOMES];

export interface TransactionUpdateOk {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.OK;
  readonly transaction: Transaction;
}

export interface TransactionUpdateReplayed {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface TransactionUpdateIdempotencyConflict {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface TransactionUpdateForbidden {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN;
}

export interface TransactionUpdateNotFound {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND;
}

export interface TransactionUpdateVersionConflict {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT;
}

export interface TransactionUpdateVoided {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.VOIDED;
}

export interface TransactionUpdateReconciled {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.RECONCILED;
}

export interface TransactionUpdateCategoryNotFound {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.CATEGORY_NOT_FOUND;
}

export interface TransactionUpdatePayeeNotFound {
  readonly kind: typeof TRANSACTION_UPDATE_OUTCOMES.PAYEE_NOT_FOUND;
}

// updateTransaction declares 200, 401, 403, 404, 409, 412, 422 in the authority:
// - 403 when the caller has no active role or is a viewer
// - 404 when the transaction does not exist or belongs to another workspace (scoped SQL predicate)
// - 409 on idempotency conflict, when transaction is voided, or when transaction is reconciled (Épica 5 stub)
// - 412 when If-Match version precondition fails
// - 422 on input validation errors, non-empty splits, or invalid category/payee references
export type TransactionUpdateOutcome =
  | TransactionUpdateOk
  | TransactionUpdateReplayed
  | TransactionUpdateIdempotencyConflict
  | TransactionUpdateForbidden
  | TransactionUpdateNotFound
  | TransactionUpdateVersionConflict
  | TransactionUpdateVoided
  | TransactionUpdateReconciled
  | TransactionUpdateCategoryNotFound
  | TransactionUpdatePayeeNotFound;

export interface VoidTransactionCommand {
  readonly reason: string;
}

export const TRANSACTION_VOID_OUTCOMES = {
  OK: 'ok',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VERSION_CONFLICT: 'version_conflict',
  DRAFT: 'draft',
  VOIDED: 'voided',
  RECONCILED: 'reconciled',
} as const;
export type TransactionVoidOutcomeKind =
  (typeof TRANSACTION_VOID_OUTCOMES)[keyof typeof TRANSACTION_VOID_OUTCOMES];

export interface TransactionVoidOk {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.OK;
  readonly transaction: Transaction;
}

export interface TransactionVoidReplayed {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface TransactionVoidIdempotencyConflict {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface TransactionVoidForbidden {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.FORBIDDEN;
}

export interface TransactionVoidNotFound {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.NOT_FOUND;
}

export interface TransactionVoidVersionConflict {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT;
}

export interface TransactionVoidDraft {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.DRAFT;
}

export interface TransactionVoidVoided {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.VOIDED;
}

export interface TransactionVoidReconciled {
  readonly kind: typeof TRANSACTION_VOID_OUTCOMES.RECONCILED;
}

// voidTransaction declares 200, 401, 403, 404, 409, 412, 422 in the authority:
// - 403 when the caller has no active role or is a viewer
// - 404 when the transaction does not exist or belongs to another workspace (scoped SQL predicate)
// - 409 on idempotency conflict, when transaction is draft, voided, or reconciled (Épica 5 stub)
// - 412 when If-Match version precondition fails
// - 422 on input validation errors (reason length bounds, missing/unknown properties)
export type TransactionVoidOutcome =
  | TransactionVoidOk
  | TransactionVoidReplayed
  | TransactionVoidIdempotencyConflict
  | TransactionVoidForbidden
  | TransactionVoidNotFound
  | TransactionVoidVersionConflict
  | TransactionVoidDraft
  | TransactionVoidVoided
  | TransactionVoidReconciled;

export interface LedgerPort {
  create(
    subject: string,
    workspaceId: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<TransactionCreateOutcome>;
  read(
    subject: string,
    workspaceId: string,
    transactionId: string,
  ): Promise<TransactionReadOutcome>;
  list(
    subject: string,
    query: TransactionListQuery,
  ): Promise<TransactionListOutcome>;
  update(
    subject: string,
    workspaceId: string,
    transactionId: string,
    command: UpdateTransactionCommand,
    idempotencyKey: string,
    expectedVersions?: number | readonly number[],
  ): Promise<TransactionUpdateOutcome>;
  void(
    subject: string,
    workspaceId: string,
    transactionId: string,
    command: VoidTransactionCommand,
    idempotencyKey: string,
    expectedVersions?: number | readonly number[],
  ): Promise<TransactionVoidOutcome>;
}
