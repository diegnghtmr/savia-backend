import type { TransactionClient } from '../platform/pg-transaction.js';

export const RECONCILIATIONS_PORT = Symbol('ReconciliationsPort');

export const RECONCILIATION_STATUSES = [
  'open',
  'completed',
  'cancelled',
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface Reconciliation {
  readonly id: string;
  readonly accountId: string;
  readonly statementDate: string;
  readonly statementBalance: Money;
  readonly systemBalance: Money;
  readonly difference: Money;
  readonly status: ReconciliationStatus;
  readonly completedAt: string | null;
}

export interface CreateReconciliationCommand {
  readonly accountId: string;
  readonly statementDate: string;
  readonly statementBalance: Money;
  readonly notes?: string | null;
}

export interface CompleteReconciliationCommand {
  readonly transactionIds: readonly string[];
  readonly createAdjustment: boolean;
  readonly adjustmentReason?: string | null;
}

export class ReconciliationAccountNotFoundError extends Error {
  public constructor(message = 'Account not found in workspace.') {
    super(message);
    this.name = 'ReconciliationAccountNotFoundError';
  }
}

export class OpenReconciliationExistsError extends Error {
  public constructor(
    message = 'An open reconciliation already exists for this account.',
  ) {
    super(message);
    this.name = 'OpenReconciliationExistsError';
  }
}

export class AmountOutOfRangeError extends Error {
  public constructor(
    message = 'Amount or computed difference exceeds signed 64-bit integer range.',
  ) {
    super(message);
    this.name = 'AmountOutOfRangeError';
  }
}

export const RECONCILIATION_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  ACCOUNT_NOT_FOUND: 'account-not-found',
  ACCOUNT_CLOSED: 'account-closed',
  CURRENCY_MISMATCH: 'currency-mismatch',
  FUTURE_STATEMENT_DATE: 'future-statement-date',
  OPEN_RECONCILIATION_EXISTS: 'open-reconciliation-exists',
  AMOUNT_OUT_OF_RANGE: 'amount-out-of-range',
} as const;

export type ReconciliationCreateOutcomeKind =
  (typeof RECONCILIATION_CREATE_OUTCOMES)[keyof typeof RECONCILIATION_CREATE_OUTCOMES];

export interface ReconciliationCreateCreated {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.CREATED;
  readonly reconciliation: Reconciliation;
}

export interface ReconciliationCreateReplayed {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface ReconciliationCreateForbidden {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.FORBIDDEN;
}

export interface ReconciliationCreateIdempotencyConflict {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface ReconciliationCreateAccountNotFound {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND;
}

export interface ReconciliationCreateAccountClosed {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_CLOSED;
}

export interface ReconciliationCreateCurrencyMismatch {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.CURRENCY_MISMATCH;
}

export interface ReconciliationCreateFutureStatementDate {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.FUTURE_STATEMENT_DATE;
}

export interface ReconciliationCreateOpenExists {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.OPEN_RECONCILIATION_EXISTS;
}

export interface ReconciliationCreateAmountOutOfRange {
  readonly kind: typeof RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE;
}

export type ReconciliationCreateOutcome =
  | ReconciliationCreateCreated
  | ReconciliationCreateReplayed
  | ReconciliationCreateForbidden
  | ReconciliationCreateIdempotencyConflict
  | ReconciliationCreateAccountNotFound
  | ReconciliationCreateAccountClosed
  | ReconciliationCreateCurrencyMismatch
  | ReconciliationCreateFutureStatementDate
  | ReconciliationCreateOpenExists
  | ReconciliationCreateAmountOutOfRange;

export const RECONCILIATION_GET_OUTCOMES = {
  FOUND: 'found',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
} as const;

export const RECONCILIATION_COMPLETE_OUTCOMES = {
  COMPLETED: 'completed',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  NOT_FOUND: 'not-found',
  ALREADY_FINAL: 'already-final',
  TRANSACTIONS_INVALID: 'transactions-invalid',
  ADJUSTMENT_INVALID: 'adjustment-invalid',
  AMOUNT_OUT_OF_RANGE: 'amount-out-of-range',
} as const;

export type ReconciliationCompleteOutcomeKind =
  (typeof RECONCILIATION_COMPLETE_OUTCOMES)[keyof typeof RECONCILIATION_COMPLETE_OUTCOMES];

export interface ReconciliationCompleteCompleted {
  readonly kind: typeof RECONCILIATION_COMPLETE_OUTCOMES.COMPLETED;
  readonly reconciliation: Reconciliation;
}

export interface ReconciliationCompleteReplayed {
  readonly kind: typeof RECONCILIATION_COMPLETE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export type ReconciliationCompleteOutcome =
  | ReconciliationCompleteCompleted
  | ReconciliationCompleteReplayed
  | {
      readonly kind: Exclude<
        ReconciliationCompleteOutcomeKind,
        'completed' | 'replayed'
      >;
    };

export type ReconciliationGetOutcomeKind =
  (typeof RECONCILIATION_GET_OUTCOMES)[keyof typeof RECONCILIATION_GET_OUTCOMES];

export interface ReconciliationGetFound {
  readonly kind: typeof RECONCILIATION_GET_OUTCOMES.FOUND;
  readonly reconciliation: Reconciliation;
}

export interface ReconciliationGetNotFound {
  readonly kind: typeof RECONCILIATION_GET_OUTCOMES.NOT_FOUND;
}

export interface ReconciliationGetForbidden {
  readonly kind: typeof RECONCILIATION_GET_OUTCOMES.FORBIDDEN;
}

export type ReconciliationGetOutcome =
  | ReconciliationGetFound
  | ReconciliationGetNotFound
  | ReconciliationGetForbidden;

export interface ReconciliationStoreAccount {
  readonly id: string;
  readonly currency: string;
  readonly status: string;
}

export interface ReconciliationStoreBalance {
  readonly nativeBalance: {
    readonly amountMinor: string;
    readonly currency: string;
  };
}

export interface ReconciliationStoreInsertData {
  readonly accountId: string;
  readonly statementDate: string;
  readonly statementBalance: Money;
  readonly systemBalance: Money;
  readonly difference: Money;
  readonly status: 'open';
  readonly notes?: string | null;
}

export interface ReconciliationStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  readAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<ReconciliationStoreAccount | undefined>;

  readAccountBalance(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    asOf?: string,
  ): Promise<ReconciliationStoreBalance | undefined>;

  createReconciliation(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    data: ReconciliationStoreInsertData,
  ): Promise<Reconciliation>;

  findReconciliationById(
    client: TransactionClient,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<Reconciliation | undefined>;
  lockAndReadCompletion(
    client: TransactionClient,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<Reconciliation | undefined>;
  validateCompletionTransactions(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    transactionIds: readonly string[],
    statementDate: string,
  ): Promise<
    | 'valid'
    | 'not-found'
    | 'no-posting'
    | 'wrong-status'
    | 'already-reconciled'
    | 'after-cutoff'
  >;
  reconcileTransactions(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    transactionIds: readonly string[],
  ): Promise<void>;
  completeReconciliation(
    client: TransactionClient,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<Reconciliation | undefined>;
}

export interface ReconciliationsPort {
  createReconciliation(
    subject: string,
    workspaceId: string,
    command: CreateReconciliationCommand,
    idempotencyKey: string,
  ): Promise<ReconciliationCreateOutcome>;

  getReconciliation(
    subject: string,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<ReconciliationGetOutcome>;
  completeReconciliation(
    subject: string,
    workspaceId: string,
    reconciliationId: string,
    command: CompleteReconciliationCommand,
    idempotencyKey: string,
  ): Promise<ReconciliationCompleteOutcome>;
}
