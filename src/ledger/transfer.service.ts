import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { LedgerTransaction } from './transaction.service.js';
import {
  TRANSFER_CREATE_OUTCOMES,
  type CreateTransferCommand,
  type Transfer,
  type TransferCreateOutcome,
  type TransferPort,
} from './transfer.port.js';

export interface TransferAccountRecord {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
}

export interface TransferStore {
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

  createTransfer(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateTransferCommand,
  ): Promise<Transfer>;
}

export class TransferService implements TransferPort {
  public constructor(
    private readonly transaction: LedgerTransaction,
    private readonly store: TransferStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public async create(
    subject: string,
    workspaceId: string,
    command: CreateTransferCommand,
    idempotencyKey: string,
  ): Promise<TransferCreateOutcome> {
    const route = 'POST /v1/transfers';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // 1. Role check: owner, administrator, editor
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: TRANSFER_CREATE_OUTCOMES.FORBIDDEN };
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
          return { kind: TRANSFER_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: TRANSFER_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // 3. Lock and read both accounts in workspace (locks acquired in sorted order)
      const { sourceAccount, destinationAccount } =
        await this.store.lockAndReadAccounts(
          client,
          workspaceId,
          command.sourceAccountId,
          command.destinationAccountId,
        );

      if (sourceAccount === undefined || destinationAccount === undefined) {
        return { kind: TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED };
      }

      if (
        sourceAccount.status === 'closed' ||
        destinationAccount.status === 'closed'
      ) {
        return { kind: TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED };
      }

      // 4. Same currency check (currency conversion is Épica 3; refuse rather than convert)
      if (
        sourceAccount.currency !== destinationAccount.currency ||
        command.amount.currency !== sourceAccount.currency
      ) {
        return { kind: TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH };
      }

      if (
        command.fee !== undefined &&
        command.fee.currency !== sourceAccount.currency
      ) {
        return { kind: TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH };
      }

      // 5. Create transfer via store
      const transfer = await this.store.createTransfer(
        client,
        workspaceId,
        subject,
        command,
      );

      // 6. Write idempotency record (NO ETag response header for createTransfer)
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
            return { kind: TRANSFER_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: TRANSFER_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: TRANSFER_CREATE_OUTCOMES.CREATED,
        transfer,
      };
    });
  }
}
