import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  OpenReconciliationExistsError,
  RECONCILIATION_CREATE_OUTCOMES,
  RECONCILIATION_GET_OUTCOMES,
  ReconciliationAccountNotFoundError,
  type CreateReconciliationCommand,
  type Money,
  type Reconciliation,
  type ReconciliationCreateOutcome,
  type ReconciliationGetOutcome,
  type ReconciliationStore,
  type ReconciliationsPort,
} from './reconciliation.port.js';

export interface ReconciliationTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ReconciliationService implements ReconciliationsPort {
  public constructor(
    private readonly transaction: ReconciliationTransaction,
    private readonly store: ReconciliationStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async createReconciliation(
    subject: string,
    workspaceId: string,
    command: CreateReconciliationCommand,
    idempotencyKey: string,
  ): Promise<ReconciliationCreateOutcome> {
    const route = 'POST /v1/reconciliations';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: owner, administrator, editor
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.FORBIDDEN };
      }

      // 2. RULING 75: Idempotency check before any insert
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: RECONCILIATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: RECONCILIATION_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. RULING 73: The account must exist in workspace and not be closed
      const account = await this.store.readAccount(
        client,
        workspaceId,
        command.accountId,
      );
      if (account === undefined) {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND };
      }
      if (account.status === 'closed') {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_CLOSED };
      }

      // 4. RULING 70: Currency must match account's currency exactly
      if (
        command.statementBalance.currency.toUpperCase() !==
        account.currency.toUpperCase()
      ) {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.CURRENCY_MISMATCH };
      }

      // 5. RULING 72: statementDate must not be in the future (UTC)
      const todayUtc = new Date().toISOString().slice(0, 10);
      if (command.statementDate > todayUtc) {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.FUTURE_STATEMENT_DATE };
      }

      // 6. RULING 69: Compute systemBalance as of the end of statementDate (UTC)
      const asOf = `${command.statementDate}T23:59:59.999999Z`;
      const balance = await this.store.readAccountBalance(
        client,
        workspaceId,
        command.accountId,
        asOf,
      );
      if (balance === undefined) {
        throw new Error('Account balance query returned no result.');
      }

      const systemBalance: Money = {
        amountMinor: balance.nativeBalance.amountMinor,
        currency: account.currency,
      };

      // 7. RULING 69: difference = statementBalance - systemBalance (minor units)
      const diffMinor =
        BigInt(command.statementBalance.amountMinor) -
        BigInt(systemBalance.amountMinor);
      const difference: Money = {
        amountMinor: diffMinor.toString(),
        currency: account.currency,
      };

      // 8. Create reconciliation row
      let reconciliation: Reconciliation;
      try {
        reconciliation = await this.store.createReconciliation(
          client,
          workspaceId,
          subject,
          {
            accountId: command.accountId,
            statementDate: command.statementDate,
            statementBalance: command.statementBalance,
            systemBalance,
            difference,
            status: 'open',
            notes: command.notes ?? null,
          },
        );
      } catch (error) {
        if (error instanceof ReconciliationAccountNotFoundError) {
          return { kind: RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND };
        }
        if (error instanceof OpenReconciliationExistsError) {
          return {
            kind: RECONCILIATION_CREATE_OUTCOMES.OPEN_RECONCILIATION_EXISTS,
          };
        }
        throw error;
      }

      // 9. RULING 75: Write idempotency record
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        null,
        reconciliation,
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
              kind: RECONCILIATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
            };
          }
          return {
            kind: RECONCILIATION_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: RECONCILIATION_CREATE_OUTCOMES.CREATED,
        reconciliation,
      };
    });
  }

  public async getReconciliation(
    subject: string,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<ReconciliationGetOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // 1. Role check: owner, administrator, editor, viewer
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      ) {
        return { kind: RECONCILIATION_GET_OUTCOMES.FORBIDDEN };
      }

      // 2. Find reconciliation scoped to workspace
      const reconciliation = await this.store.findReconciliationById(
        client,
        workspaceId,
        reconciliationId,
      );
      if (!reconciliation) {
        return { kind: RECONCILIATION_GET_OUTCOMES.NOT_FOUND };
      }

      return {
        kind: RECONCILIATION_GET_OUTCOMES.FOUND,
        reconciliation,
      };
    });
  }
}
