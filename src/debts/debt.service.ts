import { encodeCursor } from '../platform/cursor.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  DEBT_OUTCOMES,
  type CreateDebtPaymentRequest,
  type CreateDebtRequest,
  type DebtCreateOutcome,
  type DebtListOutcome,
  type DebtListQuery,
  type DebtPaymentOutcome,
  type DebtsPort,
  type DebtStore,
} from './debt.port.js';

export class DebtCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super(`Debt create rollback: ${outcome}`);
    this.name = 'DebtCreateRollbackError';
  }
}

export class DebtPaymentRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super(`Debt payment rollback: ${outcome}`);
    this.name = 'DebtPaymentRollbackError';
  }
}

export interface DebtTransactionRunner {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class DebtService implements DebtsPort {
  public constructor(
    private readonly tx: DebtTransactionRunner,
    private readonly store: DebtStore,
    private readonly idempotency: IdempotencyStore,
  ) {}

  public async createDebt(
    subject: string,
    workspaceId: string,
    command: CreateDebtRequest,
    key: string,
  ): Promise<DebtCreateOutcome> {
    const route = 'POST /v1/debts';
    const fingerprint = computeRequestFingerprint(command);

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: DEBT_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: DEBT_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: DEBT_OUTCOMES.CONFLICT };
        }

        const debt = await this.store.createDebt(client, workspaceId, command);
        const materialized =
          (await this.store.findDebt(client, workspaceId, debt.id)) ?? debt;

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          materialized,
          workspaceId,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new DebtCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new DebtCreateRollbackError('conflict');
          }
          throw new Error('Debt idempotency record could not be reread.');
        }

        return {
          kind: DEBT_OUTCOMES.CREATED,
          debt: materialized,
        };
      });
    } catch (error) {
      if (error instanceof DebtCreateRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: DEBT_OUTCOMES.REPLAYED,
              status: error.status!,
              etag: error.etag!,
              body: error.body,
            }
          : { kind: DEBT_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }

  public async listDebts(
    subject: string,
    query: DebtListQuery,
  ): Promise<DebtListOutcome> {
    return this.tx.run(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: DEBT_OUTCOMES.FORBIDDEN };
      }

      const rawItems = await this.store.listDebts(
        client,
        query,
        query.limit + 1,
      );
      const hasNextPage = rawItems.length > query.limit;
      const visible = rawItems.slice(0, query.limit);
      const last = visible[visible.length - 1];

      return {
        kind: 'ok',
        page: {
          items: visible.map((r) => r.debt),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    workspaceId: query.workspaceId,
                    createdAt: last.cursorAt,
                    id: last.debt.id,
                  })
                : null,
          },
        },
      };
    });
  }

  public async createDebtPayment(
    subject: string,
    workspaceId: string,
    debtId: string,
    command: CreateDebtPaymentRequest,
    key: string,
  ): Promise<DebtPaymentOutcome> {
    const route = 'POST /v1/debts/{debtId}/payments';
    const fingerprint = computeRequestFingerprint({
      debtId,
      ...command,
    });

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: DEBT_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: DEBT_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: DEBT_OUTCOMES.CONFLICT };
        }

        const debt = await this.store.findDebt(client, workspaceId, debtId);
        if (!debt) {
          return { kind: DEBT_OUTCOMES.NOT_FOUND };
        }

        // Currency Guard 1: Payment currency must match debt currency
        if (debt.currency !== command.totalAmount.currency) {
          return { kind: DEBT_OUTCOMES.CURRENCY_MISMATCH };
        }

        const account = await this.store.lockAndReadAccount(
          client,
          workspaceId,
          command.accountId,
        );
        if (!account) {
          return { kind: DEBT_OUTCOMES.ACCOUNT_NOT_FOUND };
        }
        if (account.status === 'closed') {
          return { kind: DEBT_OUTCOMES.ACCOUNT_CLOSED };
        }

        // Currency Guard 2: Payment currency must match source account currency
        if (account.currency !== command.totalAmount.currency) {
          return { kind: DEBT_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH };
        }

        // FIRST WRITE starts here:
        const transaction = await this.store.createDebtPayment(
          client,
          workspaceId,
          subject,
          debt,
          command,
        );

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          transaction,
          workspaceId,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new DebtPaymentRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new DebtPaymentRollbackError('conflict');
          }
          throw new Error(
            'Debt payment idempotency record could not be reread.',
          );
        }

        return {
          kind: DEBT_OUTCOMES.CREATED,
          transaction,
        };
      });
    } catch (error) {
      if (error instanceof DebtPaymentRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: DEBT_OUTCOMES.REPLAYED,
              status: error.status!,
              etag: error.etag!,
              body: error.body,
            }
          : { kind: DEBT_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }
}
