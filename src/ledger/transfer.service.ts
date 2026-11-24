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

type CreateAccountFailure =
  | 'account_unresolved'
  | 'account_closed'
  | 'currency_mismatch';

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
    return this.transaction.run(subject, (client) =>
      this.createWithin(client, subject, workspaceId, command, idempotencyKey),
    );
  }

  public async checkCreateAccounts(
    client: TransactionClient,
    workspaceId: string,
    command: CreateTransferCommand,
  ): Promise<CreateAccountFailure | undefined> {
    const { sourceAccount, destinationAccount } =
      await this.store.lockAndReadAccounts(
        client,
        workspaceId,
        command.sourceAccountId,
        command.destinationAccountId,
      );
    if (!sourceAccount || !destinationAccount)
      return TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED;
    if (
      sourceAccount.status === 'closed' ||
      destinationAccount.status === 'closed'
    ) {
      return TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED;
    }
    if (
      sourceAccount.currency !== destinationAccount.currency ||
      command.amount.currency !== sourceAccount.currency ||
      (command.fee !== undefined &&
        command.fee.currency !== sourceAccount.currency)
    ) {
      return TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH;
    }
    return undefined;
  }

  public async createWithin(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    command: CreateTransferCommand,
    idempotencyKey: string,
  ): Promise<TransferCreateOutcome> {
    const route = 'POST /v1/transfers';
    const fingerprint = computeRequestFingerprint(command);
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

    // Lock and validate both accounts before writing or reserving the key.
    const failure = await this.checkCreateAccounts(
      client,
      workspaceId,
      command,
    );
    if (failure) return { kind: failure };

    // 4. Create transfer via store
    const transfer = await this.store.createTransfer(
      client,
      workspaceId,
      subject,
      command,
    );

    // 5. Write idempotency record (NO ETag response header for createTransfer)
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
  }
}
