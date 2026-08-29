import type { Money } from './ledger.port.js';
import type { Transfer } from './transfer.port.js';

export const CURRENCY_EXCHANGE_PORT = Symbol('CurrencyExchangePort');

export interface CreateCurrencyExchangeCommand {
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  readonly sourceAmount: Money;
  readonly destinationAmount: Money;
  readonly executedRate: string;
  readonly referenceRate?: string | null;
  readonly fee?: Money;
  readonly occurredAt: string;
  readonly description?: string | null;
}

export const CURRENCY_EXCHANGE_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  ACCOUNT_UNRESOLVED: 'account_unresolved',
  ACCOUNT_CLOSED: 'account_closed',
  CURRENCY_MISMATCH: 'currency_mismatch',
} as const;
export type CurrencyExchangeCreateOutcomeKind =
  (typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES)[keyof typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES];

export interface CurrencyExchangeCreateCreated {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED;
  readonly transfer: Transfer;
}

export interface CurrencyExchangeCreateReplayed {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface CurrencyExchangeCreateIdempotencyConflict {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface CurrencyExchangeCreateForbidden {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN;
}

export interface CurrencyExchangeCreateAccountUnresolved {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED;
}

export interface CurrencyExchangeCreateAccountClosed {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_CLOSED;
}

export interface CurrencyExchangeCreateCurrencyMismatch {
  readonly kind: typeof CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH;
}

export type CurrencyExchangeCreateOutcome =
  | CurrencyExchangeCreateCreated
  | CurrencyExchangeCreateReplayed
  | CurrencyExchangeCreateIdempotencyConflict
  | CurrencyExchangeCreateForbidden
  | CurrencyExchangeCreateAccountUnresolved
  | CurrencyExchangeCreateAccountClosed
  | CurrencyExchangeCreateCurrencyMismatch;

export interface CurrencyExchangePort {
  create(
    subject: string,
    workspaceId: string,
    command: CreateCurrencyExchangeCommand,
    idempotencyKey: string,
  ): Promise<CurrencyExchangeCreateOutcome>;
}
