import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { LedgerTransaction } from './transaction.service.js';
import type { TransferAccountRecord } from './transfer.service.js';
import type { Transfer } from './transfer.port.js';
import {
  CURRENCY_EXCHANGE_CREATE_OUTCOMES,
  type CreateCurrencyExchangeCommand,
  type CurrencyExchangeCreateOutcome,
  type CurrencyExchangePort,
} from './currency-exchange.port.js';

export interface CurrencyExchangeStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  lockAndReadAccounts(
    client: TransactionClient,
    workspaceId: string,
    sourceAccountId: string,
    destinationAccountId: string,
  ): Promise<{
    sourceAccount?: TransferAccountRecord;
    destinationAccount?: TransferAccountRecord;
  }>;

  createCurrencyExchange(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateCurrencyExchangeCommand,
  ): Promise<Transfer>;
}

export class CurrencyExchangeService implements CurrencyExchangePort {
  public constructor(
    private readonly transaction: LedgerTransaction,
    private readonly store: CurrencyExchangeStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async checkCreateAccounts(
    client: TransactionClient,
    workspaceId: string,
    command: CreateCurrencyExchangeCommand,
  ) {
    const { sourceAccount, destinationAccount } =
      await this.store.lockAndReadAccounts(
        client,
        workspaceId,
        command.sourceAccountId,
        command.destinationAccountId,
      );
    if (!sourceAccount || !destinationAccount)
      return CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED;
    if (
      sourceAccount.status === 'closed' ||
      destinationAccount.status === 'closed'
    )
      return CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_CLOSED;
    if (
      sourceAccount.currency === destinationAccount.currency ||
      command.sourceAmount.currency !== sourceAccount.currency ||
      command.destinationAmount.currency !== destinationAccount.currency ||
      (command.fee !== undefined &&
        command.fee.currency !== sourceAccount.currency)
    )
      return CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH;
    return undefined;
  }

  public async create(
    subject: string,
    workspaceId: string,
    command: CreateCurrencyExchangeCommand,
    idempotencyKey: string,
    boundClient?: TransactionClient,
  ): Promise<CurrencyExchangeCreateOutcome> {
    const route = 'POST /v1/currency-exchanges';
    const fingerprint = computeRequestFingerprint(command);

    const apply = async (
      client: TransactionClient,
    ): Promise<CurrencyExchangeCreateOutcome> => {
      // 1. Role check: owner, administrator, editor
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN };
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
          return {
            kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
          };
        }
        return {
          kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      const invalid = await this.checkCreateAccounts(
        client,
        workspaceId,
        command,
      );
      if (invalid) return { kind: invalid };

      // D4: DO NOT validate that destinationAmount = sourceAmount * executedRate.
      // There is no currency exponent catalogue anywhere in this project — every currency column
      // is char(3) with a regex and no decimal places attached. The relationship between MINOR
      // units of two currencies depends on each one's exponent (e.g. JPY has 0 decimals, USD 2, KWD 3),
      // so assuming 2 would falsely reject legitimate yen exchanges. Store the three values as the
      // caller supplied them, which is exactly what FR-FX-006 requires.

      // 5. Create currency exchange via store
      const transfer = await this.store.createCurrencyExchange(
        client,
        workspaceId,
        subject,
        command,
      );

      // 6. Write idempotency record (NO ETag response header for createCurrencyExchange)
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        null,
        transfer,
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
            return {
              kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
            };
          }
          return {
            kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED,
        transfer,
      };
    };
    return boundClient
      ? apply(boundClient)
      : this.transaction.run(subject, apply);
  }
}
