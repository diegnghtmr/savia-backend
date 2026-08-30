import type { TransactionClient } from '../platform/pg-transaction.js';
import { encodeCursor } from '../platform/cursor.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import {
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_LIST_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  TRANSACTION_UPDATE_OUTCOMES,
  TRANSACTION_VOID_OUTCOMES,
  type CreateTransactionCommand,
  type LedgerPort,
  type Transaction,
  type TransactionCreateOutcome,
  type TransactionCursor,
  type TransactionListOutcome,
  type TransactionListQuery,
  type TransactionReadOutcome,
  type TransactionStatus,
  type TransactionUpdateOutcome,
  type TransactionVoidOutcome,
  type UpdateTransactionCommand,
  type VoidTransactionCommand,
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

export class TransactionCategoryNotFoundError extends Error {
  public constructor(message = 'Category not found in the workspace.') {
    super(message);
    this.name = 'TransactionCategoryNotFoundError';
  }
}

export class TransactionPayeeNotFoundError extends Error {
  public constructor(message = 'Payee not found in the workspace.') {
    super(message);
    this.name = 'TransactionPayeeNotFoundError';
  }
}

export interface LedgerAccountRecord {
  readonly status: string;
}

export interface TransactionItem {
  readonly transaction: Transaction;
  readonly cursorAt: string;
}

export interface TransactionFilterOptions {
  readonly accountId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly categoryId?: string;
  readonly status?: TransactionStatus;
  readonly query?: string;
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
  listTransactions(
    client: TransactionClient,
    workspaceId: string,
    cursor: TransactionCursor | undefined,
    limit: number,
    filters: TransactionFilterOptions,
  ): Promise<readonly TransactionItem[]>;
  updateTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
    command: UpdateTransactionCommand,
    expectedVersions?: number | readonly number[],
  ): Promise<Transaction | undefined>;
  voidTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
    accountId: string,
    postingStatus: string,
    expectedVersions?: number | readonly number[],
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
      let transaction: Transaction;
      try {
        transaction = await this.store.createTransaction(
          client,
          workspaceId,
          subject,
          command,
        );
      } catch (error) {
        if (error instanceof TransactionCategoryNotFoundError) {
          return { kind: TRANSACTION_CREATE_OUTCOMES.CATEGORY_NOT_FOUND };
        }
        if (error instanceof TransactionPayeeNotFoundError) {
          return { kind: TRANSACTION_CREATE_OUTCOMES.PAYEE_NOT_FOUND };
        }
        throw error;
      }

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
    return this.transaction.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (role === undefined) {
        return { kind: TRANSACTION_READ_OUTCOMES.FORBIDDEN };
      }
      const transaction = await this.store.readTransaction(
        client,
        workspaceId,
        transactionId,
      );
      if (transaction === undefined) {
        return { kind: TRANSACTION_READ_OUTCOMES.NOT_FOUND };
      }
      return {
        kind: TRANSACTION_READ_OUTCOMES.OK,
        transaction,
      };
    });
  }

  public list(
    subject: string,
    query: TransactionListQuery,
  ): Promise<TransactionListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (role === undefined) {
        return { kind: TRANSACTION_LIST_OUTCOMES.FORBIDDEN };
      }
      const rows = await this.store.listTransactions(
        client,
        query.workspaceId,
        query.cursor,
        query.limit + 1,
        {
          accountId: query.accountId,
          from: query.from,
          to: query.to,
          categoryId: query.categoryId,
          status: query.status,
          query: query.query,
        },
      );
      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.transaction);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              createdAt: lastItem.cursorAt,
              id: lastItem.transaction.id,
            })
          : null;
      return {
        kind: TRANSACTION_LIST_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }

  public async update(
    subject: string,
    workspaceId: string,
    transactionId: string,
    command: UpdateTransactionCommand,
    idempotencyKey: string,
    expectedVersions?: number | readonly number[],
  ): Promise<TransactionUpdateOutcome> {
    const route = 'PATCH /v1/transactions/{transactionId}';
    const fingerprint = computeRequestFingerprint({
      transactionId,
      ...command,
    });

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: only owner, administrator, editor may update transactions
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN };
      }

      // 2. Idempotency read: replay stored response if matched
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: TRANSACTION_UPDATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Pre-read existing transaction for business checks & version pre-check
      const existingTxn = await this.store.readTransaction(
        client,
        workspaceId,
        transactionId,
      );
      if (existingTxn === undefined) {
        return { kind: TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND };
      }
      if (existingTxn.status === 'voided') {
        return { kind: TRANSACTION_UPDATE_OUTCOMES.VOIDED };
      }
      // Reconciled transactions refuse field mutation (stub for Épica 5)
      if (existingTxn.status === 'reconciled') {
        return { kind: TRANSACTION_UPDATE_OUTCOMES.RECONCILED };
      }
      if (expectedVersions !== undefined) {
        const matches =
          typeof expectedVersions === 'number'
            ? existingTxn.version === expectedVersions
            : expectedVersions.includes(existingTxn.version);
        if (!matches) {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT };
        }
      }

      // 4. Atomic conditional UPDATE guarded by expected version (or existingTxn.version)
      let updated: Transaction | undefined;
      try {
        updated = await this.store.updateTransaction(
          client,
          workspaceId,
          transactionId,
          command,
          expectedVersions !== undefined
            ? expectedVersions
            : existingTxn.version,
        );
      } catch (error) {
        if (error instanceof TransactionCategoryNotFoundError) {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.CATEGORY_NOT_FOUND };
        }
        if (error instanceof TransactionPayeeNotFoundError) {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.PAYEE_NOT_FOUND };
        }
        throw error;
      }

      // 5. Zero-row update re-read to distinguish cause
      if (updated === undefined) {
        const reread = await this.store.readTransaction(
          client,
          workspaceId,
          transactionId,
        );
        if (reread === undefined) {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND };
        }
        if (reread.status === 'voided') {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.VOIDED };
        }
        if (reread.status === 'reconciled') {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.RECONCILED };
        }
        if (reread.version !== existingTxn.version) {
          return { kind: TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT };
        }
        return { kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN };
      }

      // 6. Write idempotency record
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        200,
        `"${updated.version}"`,
        updated,
        workspaceId,
      );

      if (!written) {
        const rereadIdempotency = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (rereadIdempotency !== undefined) {
          if (rereadIdempotency.requestFingerprint !== fingerprint) {
            return { kind: TRANSACTION_UPDATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: TRANSACTION_UPDATE_OUTCOMES.REPLAYED,
            status: rereadIdempotency.responseStatus,
            etag: rereadIdempotency.responseEtag,
            body: rereadIdempotency.responseBody,
          };
        }
      }

      return {
        kind: TRANSACTION_UPDATE_OUTCOMES.OK,
        transaction: updated,
      };
    });
  }

  public async void(
    subject: string,
    workspaceId: string,
    transactionId: string,
    command: VoidTransactionCommand,
    idempotencyKey: string,
    expectedVersions?: number | readonly number[],
  ): Promise<TransactionVoidOutcome> {
    const route = 'POST /v1/transactions/{transactionId}/void';
    const fingerprint = computeRequestFingerprint({
      transactionId,
      ...command,
    });

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: only owner, administrator, editor may void transactions
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: TRANSACTION_VOID_OUTCOMES.FORBIDDEN };
      }

      // 2. Idempotency read: replay stored response if matched
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: TRANSACTION_VOID_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: TRANSACTION_VOID_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Pre-read existing transaction for business checks & version pre-check
      const existingTxn = await this.store.readTransaction(
        client,
        workspaceId,
        transactionId,
      );
      if (existingTxn === undefined) {
        return { kind: TRANSACTION_VOID_OUTCOMES.NOT_FOUND };
      }
      if (existingTxn.status === 'draft') {
        return { kind: TRANSACTION_VOID_OUTCOMES.DRAFT };
      }
      if (existingTxn.status === 'voided') {
        return { kind: TRANSACTION_VOID_OUTCOMES.VOIDED };
      }
      if (existingTxn.status === 'reconciled') {
        return { kind: TRANSACTION_VOID_OUTCOMES.RECONCILED };
      }
      if (expectedVersions !== undefined) {
        const matches =
          typeof expectedVersions === 'number'
            ? existingTxn.version === expectedVersions
            : expectedVersions.includes(existingTxn.version);
        if (!matches) {
          return { kind: TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT };
        }
      }

      // 4. Void transaction in store (advisory lock, status flip, reversal postings, enforceDeferredConstraints)
      const voided = await this.store.voidTransaction(
        client,
        workspaceId,
        transactionId,
        existingTxn.accountId,
        existingTxn.status,
        expectedVersions !== undefined ? expectedVersions : existingTxn.version,
      );

      // 5. Zero-row update re-read to distinguish cause
      if (voided === undefined) {
        const reread = await this.store.readTransaction(
          client,
          workspaceId,
          transactionId,
        );
        if (reread === undefined) {
          return { kind: TRANSACTION_VOID_OUTCOMES.NOT_FOUND };
        }
        if (reread.status === 'draft') {
          return { kind: TRANSACTION_VOID_OUTCOMES.DRAFT };
        }
        if (reread.status === 'voided') {
          return { kind: TRANSACTION_VOID_OUTCOMES.VOIDED };
        }
        if (reread.status === 'reconciled') {
          return { kind: TRANSACTION_VOID_OUTCOMES.RECONCILED };
        }
        if (reread.version !== existingTxn.version) {
          return { kind: TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT };
        }
        return { kind: TRANSACTION_VOID_OUTCOMES.FORBIDDEN };
      }

      // 6. Write idempotency record (note: no ETag header in response per OpenAPI declared schema)
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        200,
        null,
        voided,
        workspaceId,
      );

      if (!written) {
        const rereadIdempotency = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (rereadIdempotency !== undefined) {
          if (rereadIdempotency.requestFingerprint !== fingerprint) {
            return { kind: TRANSACTION_VOID_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: TRANSACTION_VOID_OUTCOMES.REPLAYED,
            status: rereadIdempotency.responseStatus,
            etag: rereadIdempotency.responseEtag,
            body: rereadIdempotency.responseBody,
          };
        }
      }

      return {
        kind: TRANSACTION_VOID_OUTCOMES.OK,
        transaction: voided,
      };
    });
  }
}
