import type { TransactionClient } from '../platform/pg-transaction.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import {
  TRANSACTION_CREATE_OUTCOMES,
  type CreateTransactionCommand,
  type LedgerPort,
  type Transaction,
  type TransactionCreateOutcome,
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

export const LEDGER_STORE_CREATE_RESULTS = {
  CREATED: 'created',
  ACCOUNT_UNRESOLVED: 'account_unresolved',
  ACCOUNT_CLOSED: 'account_closed',
} as const;

export type LedgerStoreCreateResultKind =
  (typeof LEDGER_STORE_CREATE_RESULTS)[keyof typeof LEDGER_STORE_CREATE_RESULTS];

export interface LedgerStoreCreateCreated {
  readonly kind: typeof LEDGER_STORE_CREATE_RESULTS.CREATED;
  readonly transaction: Transaction;
}

export interface LedgerStoreCreateAccountUnresolved {
  readonly kind: typeof LEDGER_STORE_CREATE_RESULTS.ACCOUNT_UNRESOLVED;
}

export interface LedgerStoreCreateAccountClosed {
  readonly kind: typeof LEDGER_STORE_CREATE_RESULTS.ACCOUNT_CLOSED;
}

export type LedgerStoreCreateResult =
  | LedgerStoreCreateCreated
  | LedgerStoreCreateAccountUnresolved
  | LedgerStoreCreateAccountClosed;

export interface LedgerStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateTransactionCommand,
  ): Promise<LedgerStoreCreateResult>;
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

      // 3. Create transaction via store
      const result = await this.store.createTransaction(
        client,
        workspaceId,
        subject,
        command,
      );

      if (result.kind === LEDGER_STORE_CREATE_RESULTS.ACCOUNT_UNRESOLVED) {
        return { kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED };
      }

      if (result.kind === LEDGER_STORE_CREATE_RESULTS.ACCOUNT_CLOSED) {
        return { kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED };
      }

      const transaction = result.transaction;

      // 4. Write idempotency record
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
}
