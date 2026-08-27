import type { TransactionClient } from '../platform/pg-transaction.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import {
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  type CreateTransactionCommand,
  type LedgerPort,
  type Transaction,
  type TransactionCreateOutcome,
  type TransactionReadOutcome,
} from './ledger.port.js';

export interface LedgerTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface LedgerAccountRecord {
  readonly status: string;
}

export interface LedgerStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  lockAndReadAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<LedgerAccountRecord | undefined>;
  createTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateTransactionCommand,
  ): Promise<Transaction>;
  readTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
  ): Promise<Transaction | undefined>;
}

export class TransactionService implements LedgerPort {
  public constructor(
    private readonly transaction: LedgerTransaction,
    private readonly store: LedgerStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async create(
    subject: string,
    workspaceId: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<TransactionCreateOutcome> {
    const route = 'POST /v1/transactions';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN };
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
          return { kind: TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: TRANSACTION_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Lock and read account in workspace
      const account = await this.store.lockAndReadAccount(
        client,
        workspaceId,
        command.accountId,
      );
      if (account === undefined) {
        return { kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED };
      }
      if (account.status === 'closed') {
        return { kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED };
      }

      // 4. Create transaction via store
      const transaction = await this.store.createTransaction(
        client,
        workspaceId,
        subject,
        command,
      );

      // 5. Write idempotency record
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        `"${transaction.version}"`,
        transaction,
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
            return { kind: TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: TRANSACTION_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: TRANSACTION_CREATE_OUTCOMES.CREATED,
        transaction,
      };
    });
  }

  public read(
    subject: string,
    workspaceId: string,
    transactionId: string,
  ): Promise<TransactionReadOutcome> {
    throw new Error('Not implemented');
  }
}
