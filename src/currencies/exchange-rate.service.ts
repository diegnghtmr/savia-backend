import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  EXCHANGE_RATE_CREATE_OUTCOMES,
  type CreateManualExchangeRateCommand,
  type ExchangeRate,
  type ExchangeRateCreateOutcome,
  type ExchangeRatePort,
} from './exchange-rate.port.js';

export interface CurrenciesTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ExchangeRateAlreadyRecordedError extends Error {
  public constructor() {
    super(
      'Exchange rate for this workspace, currency pair, and effective timestamp already exists.',
    );
    this.name = 'ExchangeRateAlreadyRecordedError';
  }
}

export interface ExchangeRateStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  createManualExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateManualExchangeRateCommand,
  ): Promise<ExchangeRate>;
}

export class ExchangeRateService implements ExchangeRatePort {
  public constructor(
    private readonly transaction: CurrenciesTransaction,
    private readonly store: ExchangeRateStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async createManual(
    subject: string,
    workspaceId: string,
    command: CreateManualExchangeRateCommand,
    idempotencyKey: string,
  ): Promise<ExchangeRateCreateOutcome> {
    const route = 'POST /v1/exchange-rates';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: owner, administrator, editor (D6)
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN };
      }

      // 2. Idempotency read
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: EXCHANGE_RATE_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Create manual exchange rate via store (D1, D2, D3)
      let exchangeRate: ExchangeRate;
      try {
        exchangeRate = await this.store.createManualExchangeRate(
          client,
          workspaceId,
          subject,
          command,
        );
      } catch (error) {
        if (error instanceof ExchangeRateAlreadyRecordedError) {
          return { kind: EXCHANGE_RATE_CREATE_OUTCOMES.ALREADY_RECORDED };
        }
        throw error;
      }

      // 4. Write idempotency record (NO ETag response header for createManualExchangeRate)
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        null,
        exchangeRate,
        workspaceId,
      );

      if (!written) {
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return { kind: EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: EXCHANGE_RATE_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: EXCHANGE_RATE_CREATE_OUTCOMES.CREATED,
        exchangeRate,
      };
    });
  }
}
