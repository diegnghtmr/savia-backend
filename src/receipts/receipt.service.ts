import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { ArtifactStorage } from '../platform/artifact-storage.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  LedgerPort,
  CreateTransactionCommand,
} from '../ledger/ledger.port.js';
import { TRANSACTION_CREATE_OUTCOMES } from '../ledger/ledger.port.js';
import {
  RECEIPT_OUTCOMES,
  type ReceiptConfirmOutcome,
  type ReceiptCreateOutcome,
  type ReceiptGetOutcome,
  type ReceiptStore,
  type ReceiptsPort,
  type ReceiptTransactionCreateOutcome,
  type ReceiptUploadCommand,
} from './receipt.port.js';

export interface ReceiptTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ReceiptService implements ReceiptsPort {
  public constructor(
    private readonly tx: ReceiptTransaction,
    private readonly store: ReceiptStore,
    private readonly idempotency: IdempotencyStore,
    private readonly storage: ArtifactStorage,
    private readonly ledger: LedgerPort,
  ) {}

  public async createReceipt(
    subject: string,
    workspaceId: string,
    command: ReceiptUploadCommand,
    idempotencyKey: string,
  ): Promise<ReceiptCreateOutcome> {
    const route = 'POST /v1/receipts';
    const fingerprint = computeRequestFingerprint({
      fileName: command.fileName,
      contentType: command.contentType,
      content: command.bytes.toString('base64'),
      processingPreference: command.processingPreference,
      deviceOcrResult: command.deviceOcrResult,
    });
    return this.tx.run(subject, async (client) => {
      const role = await this.readRole(client, workspaceId);
      if (!role || !['owner', 'administrator', 'editor'].includes(role))
        return { kind: RECEIPT_OUTCOMES.FORBIDDEN };
      const existing = await this.idempotency.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing)
        return existing.requestFingerprint === fingerprint
          ? {
              kind: RECEIPT_OUTCOMES.TRANSACTION_REPLAYED,
              status: existing.responseStatus,
              body: existing.responseBody,
            }
          : { kind: RECEIPT_OUTCOMES.CONFLICT };
      const id = this.store.createId();
      const storagePath = `workspaces/${workspaceId}/receipts/${id}/${command.fileName}`;
      await this.storage.upload(
        storagePath,
        command.bytes,
        command.contentType,
      );
      try {
        const receipt = await this.store.create(
          client,
          workspaceId,
          subject,
          id,
          command,
          storagePath,
        );
        await this.idempotency.write(
          client,
          subject,
          route,
          idempotencyKey,
          fingerprint,
          202,
          null,
          receipt,
          workspaceId,
        );
        return { kind: RECEIPT_OUTCOMES.CREATED, receipt };
      } catch (error) {
        await this.storage.remove(storagePath).catch(() => undefined);
        throw error;
      }
    });
  }

  public getReceipt(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ReceiptGetOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.readRole(client, workspaceId);
      if (!role) return { kind: RECEIPT_OUTCOMES.FORBIDDEN };
      const receipt = await this.store.find(client, workspaceId, id);
      return receipt
        ? { kind: RECEIPT_OUTCOMES.FOUND, receipt }
        : { kind: RECEIPT_OUTCOMES.NOT_FOUND };
    });
  }

  public async confirmReceipt(
    subject: string,
    workspaceId: string,
    id: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<ReceiptConfirmOutcome> {
    const receipt = await this.getReceipt(subject, workspaceId, id);
    if (receipt.kind === RECEIPT_OUTCOMES.FORBIDDEN) return receipt;
    if (receipt.kind === RECEIPT_OUTCOMES.NOT_FOUND) return receipt;
    if (receipt.receipt.status === 'confirmed')
      return { kind: RECEIPT_OUTCOMES.CONFLICT };
    const outcome: ReceiptTransactionCreateOutcome = await this.ledger.create(
      subject,
      workspaceId,
      { ...command, receiptId: id },
      idempotencyKey,
    );
    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.FORBIDDEN)
      return { kind: RECEIPT_OUTCOMES.FORBIDDEN };
    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT)
      return { kind: RECEIPT_OUTCOMES.CONFLICT };
    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.REPLAYED)
      return {
        kind: RECEIPT_OUTCOMES.TRANSACTION_REPLAYED,
        status: outcome.status,
        body: outcome.body,
      };
    if (outcome.kind !== TRANSACTION_CREATE_OUTCOMES.CREATED)
      return { kind: RECEIPT_OUTCOMES.TRANSACTION_INVALID };
    const confirmed = await this.tx.run(subject, async (client) =>
      this.store.confirm(client, workspaceId, id, outcome.transaction.id),
    );
    return confirmed
      ? { kind: RECEIPT_OUTCOMES.CREATED, transaction: outcome.transaction }
      : { kind: RECEIPT_OUTCOMES.CONFLICT };
  }

  private async readRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    return result.rows[0]?.role ?? undefined;
  }
}
