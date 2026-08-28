export const EXCHANGE_RATE_PORT = Symbol('ExchangeRatePort');

export interface ExchangeRate {
  readonly id: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly effectiveAt: string;
  readonly source: string;
  readonly manual?: boolean;
}

export interface CreateManualExchangeRateCommand {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly effectiveAt: string;
  readonly notes?: string | null;
}

export const EXCHANGE_RATE_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  ALREADY_RECORDED: 'already_recorded',
} as const;
export type ExchangeRateCreateOutcomeKind =
  (typeof EXCHANGE_RATE_CREATE_OUTCOMES)[keyof typeof EXCHANGE_RATE_CREATE_OUTCOMES];

export interface ExchangeRateCreateCreated {
  readonly kind: typeof EXCHANGE_RATE_CREATE_OUTCOMES.CREATED;
  readonly exchangeRate: ExchangeRate;
}

export interface ExchangeRateCreateReplayed {
  readonly kind: typeof EXCHANGE_RATE_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface ExchangeRateCreateIdempotencyConflict {
  readonly kind: typeof EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface ExchangeRateCreateForbidden {
  readonly kind: typeof EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN;
}

export interface ExchangeRateCreateAlreadyRecorded {
  readonly kind: typeof EXCHANGE_RATE_CREATE_OUTCOMES.ALREADY_RECORDED;
}

export type ExchangeRateCreateOutcome =
  | ExchangeRateCreateCreated
  | ExchangeRateCreateReplayed
  | ExchangeRateCreateIdempotencyConflict
  | ExchangeRateCreateForbidden
  | ExchangeRateCreateAlreadyRecorded;

export interface ExchangeRatePort {
  createManual(
    subject: string,
    workspaceId: string,
    command: CreateManualExchangeRateCommand,
    idempotencyKey: string,
  ): Promise<ExchangeRateCreateOutcome>;
}
