import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import type { ArtifactStorage } from '../platform/artifact-storage.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateTransactionCommand,
  LedgerWriter,
} from '../platform/ledger-writer.port.js';
import {
  JOB_WRITER_TYPES,
  type JobWriter,
} from '../platform/job-writer.port.js';
import { TRANSACTION_CREATE_OUTCOMES } from '../ledger/ledger.port.js';
import {
  RECEIPT_OUTCOMES,
  RECEIPT_PROCESSING_PREFERENCES,
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

export class ReceiptRollbackError extends Error {
  public constructor(public readonly outcome: ReceiptConfirmOutcome) {
    super(`Receipt transaction rollback: ${outcome.kind}`);
    this.name = 'ReceiptRollbackError';
  }
}

function isSupportedImage(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return true;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return true;
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

export class ReceiptService implements ReceiptsPort {
  public constructor(
    private readonly tx: ReceiptTransaction,
    private readonly store: ReceiptStore,
    private readonly idempotency: IdempotencyStore,
    private readonly storage: ArtifactStorage,
    private readonly ledgerWriter: LedgerWriter,
    private readonly jobWriter: JobWriter,
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
        let jobId: string | undefined;
        const shouldEnqueueOcr =
          command.processingPreference ===
            RECEIPT_PROCESSING_PREFERENCES.SAVIA &&
          isSupportedImage(command.bytes);
        if (shouldEnqueueOcr) {
          const job = await this.jobWriter.createQueuedJob(
            client,
            workspaceId,
            subject,
            JOB_WRITER_TYPES.RECEIPT_OCR,
            { receiptId: id, storagePath },
          );
          jobId = job.id;
        }
        const receipt = await this.store.create(
          client,
          workspaceId,
          subject,
          id,
          command,
          storagePath,
          jobId,
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
    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.readRole(client, workspaceId);
        if (!role || !['owner', 'administrator', 'editor'].includes(role)) {
          return { kind: RECEIPT_OUTCOMES.FORBIDDEN };
        }

        const claimed = await this.store.claim(client, workspaceId, id);
        if (!claimed) {
          const existing = await this.store.find(client, workspaceId, id);
          if (!existing) {
            return { kind: RECEIPT_OUTCOMES.NOT_FOUND };
          }
          return { kind: RECEIPT_OUTCOMES.CONFLICT };
        }

        const outcome = (await this.ledgerWriter.createTransaction(
          client,
          subject,
          workspaceId,
          { ...command, receiptId: id },
          idempotencyKey,
        )) as ReceiptTransactionCreateOutcome;

        if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.FORBIDDEN) {
          throw new ReceiptRollbackError({ kind: RECEIPT_OUTCOMES.FORBIDDEN });
        }
        if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
          throw new ReceiptRollbackError({ kind: RECEIPT_OUTCOMES.CONFLICT });
        }
        if (
          outcome.kind === TRANSACTION_CREATE_OUTCOMES.RECEIPT_ALREADY_LINKED
        ) {
          throw new ReceiptRollbackError({ kind: RECEIPT_OUTCOMES.CONFLICT });
        }
        if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.REPLAYED) {
          throw new ReceiptRollbackError({
            kind: RECEIPT_OUTCOMES.TRANSACTION_REPLAYED,
            status: outcome.status,
            body: outcome.body,
          });
        }
        if (outcome.kind !== TRANSACTION_CREATE_OUTCOMES.CREATED) {
          throw new ReceiptRollbackError({
            kind: RECEIPT_OUTCOMES.TRANSACTION_INVALID,
          });
        }

        const confirmed = await this.store.confirm(
          client,
          workspaceId,
          id,
          outcome.transaction.id,
        );
        if (!confirmed) {
          throw new ReceiptRollbackError({ kind: RECEIPT_OUTCOMES.CONFLICT });
        }

        return {
          kind: RECEIPT_OUTCOMES.CREATED,
          transaction: outcome.transaction,
        };
      });
    } catch (error) {
      if (error instanceof ReceiptRollbackError) {
        return error.outcome;
      }
      throw error;
    }
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
