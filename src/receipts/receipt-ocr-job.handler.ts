import { Injectable, Logger } from '@nestjs/common';
import {
  JOB_OCR_BUDGETS,
  type JobExecutionContext,
  type OcrJobHandler,
} from '../platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { PROBLEM_TYPES } from '../platform/problem-details.js';
import type {
  OcrEnginePort,
  OcrEngineResult,
} from '../platform/ocr-engine.port.js';
import type { ArtifactStorage } from '../platform/artifact-storage.port.js';
import {
  RECEIPT_STATUSES,
  type ExtractedReceiptFields,
  type ReceiptOcrBinding,
  type ReceiptOcrJobPayload,
  type ReceiptStore,
} from './receipt.port.js';
import { extractReceiptFields } from './receipt-field-extractor.js';
import { validateReceiptImage } from './receipt-image-guard.js';
import { ReceiptInvalidStoragePathError } from './receipt-invalid-storage-path.error.js';

export class ReceiptOcrPayloadError extends Error {
  public readonly isDomainError = true;
  public readonly type = PROBLEM_TYPES.BAD_REQUEST;
  public readonly title = 'Invalid OCR Payload';
  public readonly status = 400;
  public readonly code = 'invalid_ocr_payload';

  public constructor(detail: string) {
    super(detail);
    this.name = 'ReceiptOcrPayloadError';
  }
}

function isAlreadyConfirmed(binding: ReceiptOcrBinding): boolean {
  return (
    binding.transactionId !== null ||
    binding.status === RECEIPT_STATUSES.CONFIRMED
  );
}

function validateStoragePath(
  storagePath: string,
  workspaceId: string,
  receiptId: string,
): void {
  if (storagePath.includes('..')) {
    throw new ReceiptInvalidStoragePathError(
      'Storage path contains directory traversal.',
    );
  }
  const expectedPrefix = `workspaces/${workspaceId}/receipts/${receiptId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    throw new ReceiptInvalidStoragePathError(
      'Storage path does not match the expected workspace prefix.',
    );
  }
}

@Injectable()
export class ReceiptOcrJobHandler
  implements
    OcrJobHandler<
      ReceiptOcrJobPayload,
      ReceiptOcrBinding,
      ExtractedReceiptFields
    >
{
  public readonly jobType = JOB_WRITER_TYPES.RECEIPT_OCR;
  public readonly ocrBudget = JOB_OCR_BUDGETS.RECEIPT_OCR;

  private readonly logger = new Logger('ReceiptOcrJobHandler');

  public constructor(
    private readonly receiptStore: ReceiptStore,
    private readonly storage: ArtifactStorage,
    private readonly ocrEngine: OcrEnginePort,
  ) {}

  public parsePayload(
    raw: unknown,
    execution?: Pick<JobExecutionContext<unknown>, 'workspaceId'>,
  ): ReceiptOcrJobPayload {
    if (raw === null || typeof raw !== 'object') {
      throw new ReceiptOcrPayloadError('Payload must be a non-null object.');
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.receiptId !== 'string' || !obj.receiptId) {
      throw new ReceiptOcrPayloadError(
        'Payload receiptId must be a non-empty string.',
      );
    }
    if (typeof obj.storagePath !== 'string' || !obj.storagePath) {
      throw new ReceiptOcrPayloadError(
        'Payload storagePath must be a non-empty string.',
      );
    }
    void execution;
    return {
      receiptId: obj.receiptId,
      storagePath: obj.storagePath,
    };
  }

  public async compute(
    context: JobExecutionContext<ReceiptOcrJobPayload>,
    client: TransactionClient,
  ): Promise<ReceiptOcrBinding> {
    const binding = await this.receiptStore.findOcrBinding(
      client,
      context.workspaceId,
      context.payload.receiptId,
      context.jobId,
    );
    if (!binding) {
      throw new ReceiptOcrPayloadError(
        'Receipt OCR binding not found (orphaned job).',
      );
    }
    if (binding.createdBy.toLowerCase() !== context.actorId.toLowerCase()) {
      throw new ReceiptOcrPayloadError(
        'Receipt OCR binding not found (orphaned job).',
      );
    }
    if (isAlreadyConfirmed(binding)) {
      this.logger.log(
        `receipt_ocr_superseded: job ${context.jobId} workspace ${context.workspaceId}`,
      );
      return binding;
    }
    validateStoragePath(
      binding.storagePath,
      context.workspaceId,
      context.payload.receiptId,
    );
    this.logger.log(
      `receipt_ocr_compute: job ${context.jobId} workspace ${context.workspaceId}`,
    );
    return binding;
  }

  public async download(
    context: JobExecutionContext<ReceiptOcrJobPayload>,
    computed: ReceiptOcrBinding,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    void timeoutMs;
    if (isAlreadyConfirmed(computed)) {
      this.logger.log(
        `receipt_ocr_superseded: job ${context.jobId} workspace ${context.workspaceId}`,
      );
      return Buffer.alloc(0);
    }
    this.logger.log(
      `receipt_ocr_download: job ${context.jobId} workspace ${context.workspaceId}`,
    );
    return this.storage.download(computed.storagePath, signal);
  }

  public async ocr(
    context: JobExecutionContext<ReceiptOcrJobPayload>,
    downloaded: Buffer,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ExtractedReceiptFields> {
    if (downloaded.length === 0) {
      this.logger.log(
        `receipt_ocr_superseded: job ${context.jobId} workspace ${context.workspaceId}`,
      );
      return {
        merchant: null,
        date: null,
        currency: null,
        total: null,
      };
    }
    this.logger.log(
      `receipt_ocr_recognize: job ${context.jobId} workspace ${context.workspaceId}`,
    );
    validateReceiptImage(downloaded);
    const result: OcrEngineResult = await this.ocrEngine.recognize(downloaded, {
      timeoutMs,
      signal,
    });
    return extractReceiptFields(result);
  }

  public async persist(
    context: JobExecutionContext<ReceiptOcrJobPayload>,
    computed: ExtractedReceiptFields,
    client: TransactionClient,
  ): Promise<string | null> {
    const updated = await this.receiptStore.updateOcrResultCas(
      client,
      context.workspaceId,
      context.payload.receiptId,
      context.jobId,
      computed,
    );
    if (!updated) {
      this.logger.log(
        `receipt_ocr_superseded: job ${context.jobId} workspace ${context.workspaceId}`,
      );
    }
    return context.payload.receiptId;
  }
}
