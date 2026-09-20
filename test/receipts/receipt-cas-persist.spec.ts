import { describe, expect, it, vi } from 'vitest';
import type {
  JobQueue,
  QueueMessage,
} from '../../src/platform/job-queue.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';
import type {
  PgTransaction,
  TransactionClient,
} from '../../src/platform/pg-transaction.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import type { OcrEnginePort } from '../../src/platform/ocr-engine.port.js';
import { PostgresReceiptAdapter } from '../../src/receipts/postgres-receipt.adapter.js';
import { ReceiptOcrJobHandler } from '../../src/receipts/receipt-ocr-job.handler.js';
import type { ExtractedReceiptFields } from '../../src/receipts/receipt.port.js';
import { JOB_WRITER_TYPES } from '../../src/platform/job-writer.port.js';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const JOB_ID = '00000000-0000-0000-0000-000000000002';
const ACTOR_ID = '00000000-0000-0000-0000-000000000003';
const RECEIPT_ID = '00000000-0000-0000-0000-000000000004';
const STORAGE_PATH = `workspaces/${WS_ID}/receipts/${RECEIPT_ID}/photo.jpg`;

function validPng(width = 80, height = 60): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0x12345678, 29);
  return buf;
}

const EXTRACTED_FIELDS: ExtractedReceiptFields = {
  merchant: { value: 'Store', confidence: 0.95 },
  date: { value: '2026-09-15', confidence: 0.9 },
  currency: { value: 'COP', confidence: 0.92 },
  total: { value: 45000, confidence: 0.88 },
};

function workerConfig(): WorkerConfig {
  return new WorkerConfig(
    1,
    300,
    1000,
    30,
    undefined,
    5000,
    5,
    15_000,
    180_000,
    60_000,
    20_000,
    10_000,
    1_000,
    8_000,
    30_000,
    30_000,
    30_000,
    2_000,
    10_000,
    10_000,
    20_000,
    30_000,
    2_000,
    1_073_741_824,
    1,
  );
}

function queueMessage(): QueueMessage {
  return {
    msgId: '101',
    readCt: 1,
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    vt: '2026-01-01T00:00:00.000Z',
    message: {
      job_id: JOB_ID,
      workspace_id: WS_ID,
      actor_id: ACTOR_ID,
    },
  };
}

describe('ReceiptCasPersist', () => {
  it('CAS updates receipt when transaction_id IS NULL and status in uploaded/processing', async () => {
    let sql = '';
    const client = {
      query: vi.fn(async (text: string) => {
        sql = text;
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as TransactionClient;
    const adapter = new PostgresReceiptAdapter();

    const updated = await adapter.updateOcrResultCas(
      client,
      WS_ID,
      RECEIPT_ID,
      JOB_ID,
      EXTRACTED_FIELDS,
    );

    expect(updated).toBe(true);
    expect(sql).toMatch(/transaction_id is null/i);
    expect(sql).toMatch(/job_id = \$3::uuid/i);
    expect(sql).toContain("status in ('uploaded', 'processing')");
  });

  it('confirmation race: CAS matches 0 rows (user confirmed first) — handler classifies as superseded, preserves user transaction', async () => {
    const receipt: {
      transactionId: string | null;
      status: string;
      merchant: ExtractedReceiptFields['merchant'];
    } = {
      transactionId: 'tx-confirmed',
      status: 'confirmed',
      merchant: { value: 'UserMerchant', confidence: 1 },
    };
    const client = {
      query: vi.fn(async (text: string) => {
        const guardsNullTransaction = /transaction_id is null/i.test(text);
        if (guardsNullTransaction && receipt.transactionId !== null) {
          return { rowCount: 0, rows: [] };
        }
        receipt.merchant = EXTRACTED_FIELDS.merchant;
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as TransactionClient;
    const adapter = new PostgresReceiptAdapter();
    const handler = new ReceiptOcrJobHandler(
      adapter,
      {} as ArtifactStorage,
      {} as OcrEnginePort,
    );

    const result = await handler.persist(
      {
        jobId: JOB_ID,
        workspaceId: WS_ID,
        actorId: ACTOR_ID,
        attemptCount: 1,
        payload: { receiptId: RECEIPT_ID, storagePath: STORAGE_PATH },
      },
      EXTRACTED_FIELDS,
      client,
    );

    expect(result).toBe(RECEIPT_ID);
    expect(receipt.merchant).toEqual({ value: 'UserMerchant', confidence: 1 });
    expect(receipt.transactionId).toBe('tx-confirmed');
  });

  it('claim accepts status = failed for manual confirmation after OCR failure', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (!text.includes("'failed'")) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as TransactionClient;
    const adapter = new PostgresReceiptAdapter();

    const claimed = await adapter.claim(client, WS_ID, RECEIPT_ID);

    expect(claimed).toBe(true);
    const sql = String(vi.mocked(client.query).mock.calls[0]?.[0]);
    expect(sql).toContain("'failed'");
    expect(sql).toContain(
      "status in ('uploaded', 'awaiting_review', 'failed')",
    );
  });

  it('T2 persists CAS and completeJob in one transaction; a lost ack redelivers a completed job without rerunning compute', async () => {
    const computeFn = vi.fn().mockResolvedValue({
      id: RECEIPT_ID,
      workspaceId: WS_ID,
      storagePath: STORAGE_PATH,
      jobId: JOB_ID,
      createdBy: ACTOR_ID,
      status: 'uploaded',
      transactionId: null,
    });
    const downloadFn = vi.fn().mockResolvedValue(validPng());
    const recognizeFn = vi.fn().mockResolvedValue({
      lines: [],
      tokens: [],
      rawTsv: '',
    });
    const casFn = vi.fn().mockResolvedValue(true);
    const handler = new ReceiptOcrJobHandler(
      {
        createId: vi.fn(),
        create: vi.fn(),
        find: vi.fn(),
        claim: vi.fn(),
        confirm: vi.fn(),
        findOcrBinding: computeFn,
        updateOcrResultCas: casFn,
      },
      { download: downloadFn } as unknown as ArtifactStorage,
      { recognize: recognizeFn } as unknown as OcrEnginePort,
    );

    let jobStatus = 'queued';
    const runScopes: Array<{ cas: boolean; completeJob: boolean }> = [];
    let currentScope: { cas: boolean; completeJob: boolean } | undefined;

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from public.jobs')) {
          return {
            rows: [
              {
                id: JOB_ID,
                workspace_id: WS_ID,
                created_by: ACTOR_ID,
                type: JOB_WRITER_TYPES.RECEIPT_OCR,
                status: jobStatus,
                payload: { receiptId: RECEIPT_ID, storagePath: STORAGE_PATH },
                role: 'owner',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as TransactionClient;

    const mockTransaction: Partial<PgTransaction> = {
      run: vi.fn(async (_subject, callback) => {
        const scope = { cas: false, completeJob: false };
        runScopes.push(scope);
        const previous = currentScope;
        currentScope = scope;
        try {
          return await callback(mockClient);
        } finally {
          currentScope = previous;
        }
      }),
      runRead: vi.fn(async (_subject, callback) => callback(mockClient)),
      runAsQueueConsumer: vi.fn(async (callback) => callback(mockClient)),
    };

    const mockJobWriter: Partial<JobWriter> = {
      transitionToProcessing: vi.fn(async () => {
        jobStatus = 'processing';
        return { id: JOB_ID, status: 'processing' };
      }),
      completeJob: vi.fn(async () => {
        if (currentScope) currentScope.completeJob = true;
        jobStatus = 'completed';
        return { id: JOB_ID, status: 'completed' };
      }),
      failJob: vi.fn(),
      deadLetter: vi.fn(),
      findJobById: vi.fn(),
    };

    const originalCas = casFn.getMockImplementation();
    casFn.mockImplementation(async (...args: unknown[]) => {
      if (currentScope) currentScope.cas = true;
      return originalCas ? originalCas(...args) : true;
    });

    const mockQueue: JobQueue = {
      claim: vi.fn().mockResolvedValue([queueMessage()]),
      ack: vi.fn().mockResolvedValue(true),
      archive: vi.fn().mockResolvedValue(true),
      defer: vi.fn().mockResolvedValue(true),
      failOrphanedJob: vi.fn().mockResolvedValue(true),
    };

    const runner = new JobRunner(
      mockQueue,
      mockTransaction as PgTransaction,
      mockJobWriter as JobWriter,
      workerConfig(),
      [handler],
    );

    await runner.processMessage(queueMessage());

    expect(computeFn).toHaveBeenCalledTimes(1);
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(recognizeFn).toHaveBeenCalledTimes(1);
    expect(casFn).toHaveBeenCalledTimes(1);
    expect(mockJobWriter.completeJob).toHaveBeenCalledTimes(1);
    expect(runScopes.some((scope) => scope.cas && scope.completeJob)).toBe(
      true,
    );

    computeFn.mockClear();
    downloadFn.mockClear();
    recognizeFn.mockClear();
    casFn.mockClear();
    vi.mocked(mockJobWriter.completeJob!).mockClear();
    vi.mocked(mockQueue.ack).mockClear();

    const redelivered = await runner.processMessage(queueMessage());

    expect(redelivered).toBe(true);
    expect(mockQueue.ack).toHaveBeenCalledTimes(1);
    expect(computeFn).not.toHaveBeenCalled();
    expect(downloadFn).not.toHaveBeenCalled();
    expect(recognizeFn).not.toHaveBeenCalled();
    expect(casFn).not.toHaveBeenCalled();
    expect(mockJobWriter.completeJob).not.toHaveBeenCalled();
  });

  it('CAS retry before T2 commits: a failed completeJob rolls back CAS so the next attempt can persist again', async () => {
    const receipt = {
      transactionId: null as string | null,
      status: 'uploaded',
      merchant: null as ExtractedReceiptFields['merchant'],
    };
    const adapter = new PostgresReceiptAdapter();

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from public.jobs')) {
          return {
            rows: [
              {
                id: JOB_ID,
                workspace_id: WS_ID,
                created_by: ACTOR_ID,
                type: JOB_WRITER_TYPES.RECEIPT_OCR,
                status: 'queued',
                payload: { receiptId: RECEIPT_ID, storagePath: STORAGE_PATH },
                role: 'owner',
              },
            ],
          };
        }
        if (/transaction_id is null/i.test(sql)) {
          if (receipt.transactionId !== null) {
            return { rowCount: 0, rows: [] };
          }
          receipt.status = 'awaiting_review';
          receipt.merchant = EXTRACTED_FIELDS.merchant;
          return { rowCount: 1, rows: [] };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TransactionClient;

    const mockTransaction: Partial<PgTransaction> = {
      run: vi.fn(async (_subject, callback) => {
        const snapshot = {
          transactionId: receipt.transactionId,
          status: receipt.status,
          merchant: receipt.merchant,
        };
        try {
          return await callback(mockClient);
        } catch (error) {
          receipt.transactionId = snapshot.transactionId;
          receipt.status = snapshot.status;
          receipt.merchant = snapshot.merchant;
          throw error;
        }
      }),
      runRead: vi.fn(async (_subject, callback) => callback(mockClient)),
      runAsQueueConsumer: vi.fn(async (callback) => callback(mockClient)),
    };

    const mockJobWriter: Partial<JobWriter> = {
      transitionToProcessing: vi.fn(),
      completeJob: vi.fn(async () => {
        throw new Error('persist connection reset');
      }),
      failJob: vi.fn(),
      deadLetter: vi.fn(),
      findJobById: vi.fn().mockResolvedValue({ status: 'processing' }),
    };

    const handler = new ReceiptOcrJobHandler(
      adapter,
      {
        download: vi.fn().mockResolvedValue(validPng()),
      } as unknown as ArtifactStorage,
      {
        recognize: vi.fn().mockResolvedValue({
          lines: [
            {
              pageNum: 1,
              blockNum: 1,
              parNum: 1,
              lineNum: 1,
              text: 'STORE NAME',
              confidence: 0.95,
              tokens: [],
            },
          ],
          tokens: [],
          rawTsv: '',
        }),
      } as unknown as OcrEnginePort,
    );

    const mockQueue: JobQueue = {
      claim: vi.fn().mockResolvedValue([queueMessage()]),
      ack: vi.fn().mockResolvedValue(true),
      archive: vi.fn().mockResolvedValue(true),
      defer: vi.fn().mockResolvedValue(true),
      failOrphanedJob: vi.fn().mockResolvedValue(true),
    };

    const runner = new JobRunner(
      mockQueue,
      mockTransaction as PgTransaction,
      mockJobWriter as JobWriter,
      workerConfig(),
      [handler],
    );

    vi.spyOn(adapter, 'findOcrBinding').mockResolvedValue({
      id: RECEIPT_ID,
      workspaceId: WS_ID,
      storagePath: STORAGE_PATH,
      jobId: JOB_ID,
      createdBy: ACTOR_ID,
      status: 'uploaded',
      transactionId: null,
    });

    await runner.processMessage(queueMessage());

    expect(receipt.status).toBe('uploaded');
    expect(receipt.merchant).toBeNull();
    expect(mockQueue.ack).not.toHaveBeenCalled();
  });
});
