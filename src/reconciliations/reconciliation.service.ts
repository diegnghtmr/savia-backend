import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { LedgerWriter } from '../platform/ledger-writer.port.js';
import {
  AmountOutOfRangeError,
  OpenReconciliationExistsError,
  RECONCILIATION_CREATE_OUTCOMES,
  RECONCILIATION_GET_OUTCOMES,
  RECONCILIATION_COMPLETE_OUTCOMES,
  ReconciliationAccountNotFoundError,
  ReconciliationCompletionRollbackError,
  type CreateReconciliationCommand,
  type CompleteReconciliationCommand,
  type Money,
  type Reconciliation,
  type ReconciliationCreateOutcome,
  type ReconciliationGetOutcome,
  type ReconciliationCompleteOutcome,
  type ReconciliationStore,
  type ReconciliationStoreBalance,
  type ReconciliationsPort,
} from './reconciliation.port.js';

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

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
    private readonly ledgerWriter: LedgerWriter = {
      createAdjustmentTransaction: async () => {
        throw new Error('Ledger writer is not configured.');
      },
      createImportedTransaction: async () => {
        throw new Error('Ledger writer is not configured.');
      },
      voidTransaction: async () => undefined,
    },
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
      let balance: ReconciliationStoreBalance | undefined;
      try {
        balance = await this.store.readAccountBalance(
          client,
          workspaceId,
          command.accountId,
          asOf,
        );
      } catch (error) {
        if (error instanceof AmountOutOfRangeError) {
          return { kind: RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE };
        }
        throw error;
      }
      if (balance === undefined) {
        throw new Error('Account balance query returned no result.');
      }

      const systemBalanceVal = BigInt(balance.nativeBalance.amountMinor);
      if (systemBalanceVal < INT64_MIN || systemBalanceVal > INT64_MAX) {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE };
      }

      const systemBalance: Money = {
        amountMinor: balance.nativeBalance.amountMinor,
        currency: account.currency,
      };

      // 7. RULING 69: difference = statementBalance - systemBalance (minor units)
      const diffMinor =
        BigInt(command.statementBalance.amountMinor) - systemBalanceVal;
      if (diffMinor < INT64_MIN || diffMinor > INT64_MAX) {
        return { kind: RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE };
      }

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
        if (error instanceof AmountOutOfRangeError) {
          return { kind: RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE };
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

  public async completeReconciliation(
    subject: string,
    workspaceId: string,
    reconciliationId: string,
    command: CompleteReconciliationCommand,
    idempotencyKey: string,
  ): Promise<ReconciliationCompleteOutcome> {
    const route = 'POST /v1/reconciliations/{reconciliationId}/complete';
    const fingerprint = computeRequestFingerprint({
      reconciliationId,
      ...command,
    });
    try {
      return await this.transaction.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (
          role === undefined ||
          !['owner', 'administrator', 'editor'].includes(role)
        ) {
          return { kind: RECONCILIATION_COMPLETE_OUTCOMES.FORBIDDEN };
        }
        const existing = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (existing) {
          if (existing.requestFingerprint !== fingerprint)
            return {
              kind: RECONCILIATION_COMPLETE_OUTCOMES.IDEMPOTENCY_CONFLICT,
            };
          return {
            kind: RECONCILIATION_COMPLETE_OUTCOMES.REPLAYED,
            status: existing.responseStatus,
            etag: existing.responseEtag,
            body: existing.responseBody,
          };
        }
        const reconciliation = await this.store.lockAndReadCompletion(
          client,
          workspaceId,
          reconciliationId,
        );
        if (!reconciliation)
          return { kind: RECONCILIATION_COMPLETE_OUTCOMES.NOT_FOUND };
        if (reconciliation.status !== 'open')
          return { kind: RECONCILIATION_COMPLETE_OUTCOMES.ALREADY_FINAL };
        if (!command.createAdjustment && 'adjustmentReason' in command) {
          return { kind: RECONCILIATION_COMPLETE_OUTCOMES.ADJUSTMENT_INVALID };
        }
        if (
          command.createAdjustment &&
          reconciliation.difference.amountMinor === '0'
        ) {
          return { kind: RECONCILIATION_COMPLETE_OUTCOMES.ADJUSTMENT_INVALID };
        }
        const adjustmentAmount = BigInt(reconciliation.difference.amountMinor);
        if (
          command.createAdjustment &&
          (adjustmentAmount < INT64_MIN ||
            adjustmentAmount > INT64_MAX ||
            adjustmentAmount === INT64_MIN)
        ) {
          throw new ReconciliationCompletionRollbackError(
            'amount-out-of-range',
          );
        }
        const validation = await this.store.validateCompletionTransactions(
          client,
          workspaceId,
          reconciliation.accountId,
          command.transactionIds,
          reconciliation.statementDate,
        );
        if (validation !== 'valid')
          return {
            kind: RECONCILIATION_COMPLETE_OUTCOMES.TRANSACTIONS_INVALID,
          };
        await this.store.reconcileTransactions(
          client,
          workspaceId,
          reconciliation.accountId,
          command.transactionIds,
        );
        if (command.createAdjustment) {
          await this.ledgerWriter.createAdjustmentTransaction(
            client,
            workspaceId,
            subject,
            {
              accountId: reconciliation.accountId,
              currency: reconciliation.difference.currency,
              amountMinor: reconciliation.difference.amountMinor,
              occurredAt: new Date().toISOString(),
              description: command.adjustmentReason ?? null,
            },
          );
        }
        const completed = await this.store.completeReconciliation(
          client,
          workspaceId,
          reconciliationId,
        );
        if (!completed)
          return { kind: RECONCILIATION_COMPLETE_OUTCOMES.ALREADY_FINAL };
        const written = await this.idempotencyStore.write(
          client,
          subject,
          route,
          idempotencyKey,
          fingerprint,
          200,
          null,
          completed,
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
          if (reread && reread.requestFingerprint === fingerprint)
            return {
              kind: RECONCILIATION_COMPLETE_OUTCOMES.REPLAYED,
              status: reread.responseStatus,
              etag: reread.responseEtag,
              body: reread.responseBody,
            };
          return {
            kind: RECONCILIATION_COMPLETE_OUTCOMES.IDEMPOTENCY_CONFLICT,
          };
        }
        return {
          kind: RECONCILIATION_COMPLETE_OUTCOMES.COMPLETED,
          reconciliation: completed,
        };
      });
    } catch (error: unknown) {
      if (error instanceof ReconciliationCompletionRollbackError) {
        return { kind: error.outcome };
      }
      if (
        error instanceof RangeError ||
        error instanceof AmountOutOfRangeError
      ) {
        return { kind: RECONCILIATION_COMPLETE_OUTCOMES.AMOUNT_OUT_OF_RANGE };
      }
      throw error;
    }
  }
}
