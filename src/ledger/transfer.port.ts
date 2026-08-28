import type { Money, TransactionStatus } from './ledger.port.js';

export const TRANSFER_PORT = Symbol('TransferPort');

export interface Transfer {
  readonly id: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly sourceAmount: Money;
  readonly destinationAmount: Money;
  readonly occurredAt: string;
  readonly status: TransactionStatus;
  readonly fee?: Money;
  readonly exchangeRate?: string | null;
  readonly referenceRate?: string | null;
  readonly transactionId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly version?: number;
}

export interface CreateTransferCommand {
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly amount: Money;
  readonly occurredAt: string;
  readonly fee?: Money;
  readonly description?: string | null;
}

export const TRANSFER_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  ACCOUNT_UNRESOLVED: 'account_unresolved',
  ACCOUNT_CLOSED: 'account_closed',
  CURRENCY_MISMATCH: 'currency_mismatch',
} as const;
export type TransferCreateOutcomeKind =
  (typeof TRANSFER_CREATE_OUTCOMES)[keyof typeof TRANSFER_CREATE_OUTCOMES];

export interface TransferCreateCreated {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.CREATED;
  readonly transfer: Transfer;
}

export interface TransferCreateReplayed {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface TransferCreateIdempotencyConflict {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface TransferCreateForbidden {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.FORBIDDEN;
}

export interface TransferCreateAccountUnresolved {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED;
}

export interface TransferCreateAccountClosed {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED;
}

export interface TransferCreateCurrencyMismatch {
  readonly kind: typeof TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH;
}

export type TransferCreateOutcome =
  | TransferCreateCreated
  | TransferCreateReplayed
  | TransferCreateIdempotencyConflict
  | TransferCreateForbidden
  | TransferCreateAccountUnresolved
  | TransferCreateAccountClosed
  | TransferCreateCurrencyMismatch;

export interface TransferPort {
  create(
    subject: string,
    workspaceId: string,
    command: CreateTransferCommand,
    idempotencyKey: string,
  ): Promise<TransferCreateOutcome>;
}
