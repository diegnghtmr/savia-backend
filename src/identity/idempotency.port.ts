import type { TransactionClient } from './pg-transaction.js';

export const IDEMPOTENCY_PORT = Symbol('IdempotencyPort');

export const IDEMPOTENCY_OUTCOME_KINDS = {
  EXECUTED: 'executed',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
} as const;

export type IdempotencyOutcomeKind =
  (typeof IDEMPOTENCY_OUTCOME_KINDS)[keyof typeof IDEMPOTENCY_OUTCOME_KINDS];

export interface StoredResponse {
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface IdempotencyRecord {
  readonly requestFingerprint: string;
  readonly responseStatus: number;
  readonly responseEtag: string | null;
  readonly responseBody: unknown;
}

export interface IdempotencyRequest<T = unknown> {
  readonly subject: string;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly payload: T;
}

export interface IdempotencyExecutedOutcome {
  readonly kind: typeof IDEMPOTENCY_OUTCOME_KINDS.EXECUTED;
  readonly response: StoredResponse;
}

export interface IdempotencyReplayedOutcome {
  readonly kind: typeof IDEMPOTENCY_OUTCOME_KINDS.REPLAYED;
  readonly response: StoredResponse;
}

export interface IdempotencyConflictOutcome {
  readonly kind: typeof IDEMPOTENCY_OUTCOME_KINDS.CONFLICT;
}

export type IdempotencyOutcome =
  | IdempotencyExecutedOutcome
  | IdempotencyReplayedOutcome
  | IdempotencyConflictOutcome;

export interface IdempotencyStore {
  read(
    client: TransactionClient,
    subject: string,
    route: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined>;
  write(
    client: TransactionClient,
    subject: string,
    route: string,
    idempotencyKey: string,
    fingerprint: string,
    status: number,
    etag: string | null,
    body: unknown,
  ): Promise<boolean>;
}

export interface IdempotencyPort {
  execute<TResult extends StoredResponse>(
    request: IdempotencyRequest,
    operation: (client: TransactionClient) => Promise<TResult>,
  ): Promise<IdempotencyOutcome>;
}
