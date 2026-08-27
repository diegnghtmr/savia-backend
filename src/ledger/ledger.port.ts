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

export type TransactionCreateOutcome =
  | TransactionCreateCreated
  | TransactionCreateReplayed
  | TransactionCreateIdempotencyConflict
  | TransactionCreateForbidden
  | TransactionCreateAccountUnresolved
  | TransactionCreateAccountClosed;

export interface LedgerPort {
  create(
    subject: string,
    workspaceId: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<TransactionCreateOutcome>;
}
