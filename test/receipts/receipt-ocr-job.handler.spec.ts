import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import type {
  OcrEnginePort,
  OcrEngineResult,
} from '../../src/platform/ocr-engine.port.js';
import type {
  ExtractedReceiptFields,
  ReceiptOcrBinding,
  ReceiptOcrJobPayload,
  ReceiptStore,
} from '../../src/receipts/receipt.port.js';
import type { JobExecutionContext } from '../../src/platform/job-handler.port.js';
import { JOB_OCR_BUDGETS } from '../../src/platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../../src/platform/job-writer.port.js';
import {
  ReceiptOcrJobHandler,
  ReceiptOcrPayloadError,
} from '../../src/receipts/receipt-ocr-job.handler.js';
import { ReceiptInvalidStoragePathError } from '../../src/receipts/receipt-invalid-storage-path.error.js';

function fakeClient(): TransactionClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as TransactionClient;
}

function makeBinding(
  overrides?: Partial<ReceiptOcrBinding>,
): ReceiptOcrBinding {
  return {
    id: 'receipt-1',
    workspaceId: 'ws-1',
    storagePath: 'workspaces/ws-1/receipts/receipt-1/photo.jpg',
    jobId: 'job-1',
    createdBy: 'actor-1',
    status: 'uploaded',
    transactionId: null,
    ...overrides,
  };
}

function makeContext(
  overrides?: Partial<JobExecutionContext<ReceiptOcrJobPayload>>,
): JobExecutionContext<ReceiptOcrJobPayload> {
  return {
    jobId: 'job-1',
    workspaceId: 'ws-1',
    actorId: 'actor-1',
    attemptCount: 1,
    payload: {
      receiptId: 'receipt-1',
      storagePath: 'workspaces/ws-1/receipts/receipt-1/photo.jpg',
    },
    ...overrides,
  };
}

function makeOcrResult(): OcrEngineResult {
  return {
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
  };
}

describe('ReceiptOcrJobHandler', () => {
  let store: ReceiptStore;
  let storage: ArtifactStorage;
  let ocrEngine: OcrEnginePort;
  let handler: ReceiptOcrJobHandler;
  let logMessages: string[];

  beforeEach(() => {
    store = {
      createId: vi.fn(),
      create: vi.fn(),
      find: vi.fn(),
      claim: vi.fn(),
      confirm: vi.fn(),
      findOcrBinding: vi.fn().mockResolvedValue(makeBinding()),
      updateOcrResultCas: vi.fn().mockResolvedValue(true),
    };
    storage = {
      upload: vi.fn(),
      sign: vi.fn(),
      download: vi.fn().mockResolvedValue(Buffer.from('image-bytes')),
      remove: vi.fn(),
    };
    ocrEngine = {
      recognize: vi.fn().mockResolvedValue(makeOcrResult()),
    };
    handler = new ReceiptOcrJobHandler(store, storage, ocrEngine);
    logMessages = [];
    (
      handler as unknown as { logger: { log: (...args: unknown[]) => void } }
    ).logger.log = (...args: unknown[]) => {
      logMessages.push(String(args[0]));
    };
  });

  describe('metadata', () => {
    it('declares receipt_ocr job type', () => {
      expect(handler.jobType).toBe(JOB_WRITER_TYPES.RECEIPT_OCR);
    });

    it('declares RECEIPT_OCR budget', () => {
      expect(handler.ocrBudget).toBe(JOB_OCR_BUDGETS.RECEIPT_OCR);
    });
  });

  describe('parsePayload', () => {
    it('parses valid payload', () => {
      const result = handler.parsePayload({
        receiptId: 'abc',
        storagePath: 'some/path',
      });
      expect(result).toEqual({
        receiptId: 'abc',
        storagePath: 'some/path',
      });
    });

    it('rejects null payload', () => {
      expect(() => handler.parsePayload(null)).toThrow(ReceiptOcrPayloadError);
    });

    it('rejects missing receiptId', () => {
      expect(() => handler.parsePayload({ storagePath: 'some/path' })).toThrow(
        ReceiptOcrPayloadError,
      );
    });
  });

  describe('compute (T1 read)', () => {
    it('returns binding from findOcrBinding', async () => {
      const ctx = makeContext();
      const client = fakeClient();
      const result = await handler.compute(ctx, client);
      expect(result).toEqual(makeBinding());
      expect(store.findOcrBinding).toHaveBeenCalledWith(
        client,
        'ws-1',
        'receipt-1',
        'job-1',
      );
    });

    it('throws orphaned error when findOcrBinding returns null — no I/O', async () => {
      vi.mocked(store.findOcrBinding).mockResolvedValue(null);
      const ctx = makeContext();
      const client = fakeClient();
      await expect(handler.compute(ctx, client)).rejects.toThrow(
        ReceiptOcrPayloadError,
      );
      expect(storage.download).not.toHaveBeenCalled();
      expect(ocrEngine.recognize).not.toHaveBeenCalled();
    });

    it('throws orphaned error when createdBy does not match actor — no I/O', async () => {
      vi.mocked(store.findOcrBinding).mockResolvedValue(
        makeBinding({ createdBy: 'someone-else' }),
      );
      await expect(
        handler.compute(makeContext(), fakeClient()),
      ).rejects.toThrow(ReceiptOcrPayloadError);
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('throws ReceiptInvalidStoragePathError on directory traversal — before download', async () => {
      vi.mocked(store.findOcrBinding).mockResolvedValue(
        makeBinding({
          storagePath: 'workspaces/ws-1/receipts/../../../etc/passwd',
        }),
      );
      const ctx = makeContext();
      const client = fakeClient();
      await expect(handler.compute(ctx, client)).rejects.toThrow(
        ReceiptInvalidStoragePathError,
      );
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('throws ReceiptInvalidStoragePathError on prefix mismatch — before download', async () => {
      vi.mocked(store.findOcrBinding).mockResolvedValue(
        makeBinding({
          storagePath: 'workspaces/other-ws/receipts/receipt-1/photo.jpg',
        }),
      );
      const ctx = makeContext();
      const client = fakeClient();
      await expect(handler.compute(ctx, client)).rejects.toThrow(
        ReceiptInvalidStoragePathError,
      );
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('throws ReceiptInvalidStoragePathError when path is not under this receipt id — before download', async () => {
      vi.mocked(store.findOcrBinding).mockResolvedValue(
        makeBinding({
          storagePath: 'workspaces/ws-1/receipts/other-receipt/photo.jpg',
        }),
      );
      await expect(
        handler.compute(makeContext(), fakeClient()),
      ).rejects.toThrow(ReceiptInvalidStoragePathError);
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('ReceiptInvalidStoragePathError has isDomainError = true (permanent)', () => {
      const err = new ReceiptInvalidStoragePathError('test');
      expect(err.isDomainError).toBe(true);
    });
  });

  describe('download', () => {
    it('downloads from storage path', async () => {
      const ctx = makeContext();
      const binding = makeBinding();
      const signal = new AbortController().signal;
      const result = await handler.download(ctx, binding, 5000, signal);
      expect(result).toEqual(Buffer.from('image-bytes'));
      expect(storage.download).toHaveBeenCalledWith(
        binding.storagePath,
        signal,
      );
    });
  });

  describe('ocr', () => {
    it('runs OCR and extracts fields', async () => {
      const ctx = makeContext();
      const buf = Buffer.from('image-bytes');
      const signal = new AbortController().signal;
      const result = await handler.ocr(ctx, buf, 5000, signal);
      expect(ocrEngine.recognize).toHaveBeenCalledWith(buf, {
        timeoutMs: 5000,
        signal,
      });
      expect(result).toHaveProperty('merchant');
    });
  });

  describe('persist (T2 CAS)', () => {
    it('calls updateOcrResultCas and returns receiptId on success', async () => {
      const ctx = makeContext();
      const fields: ExtractedReceiptFields = {
        merchant: { value: 'Store', confidence: 0.9 },
        date: null,
        currency: null,
        total: null,
      };
      const client = fakeClient();
      const result = await handler.persist(ctx, fields, client);
      expect(result).toBe('receipt-1');
      expect(store.updateOcrResultCas).toHaveBeenCalledWith(
        client,
        'ws-1',
        'receipt-1',
        fields,
      );
    });

    it('when CAS returns 0 rows (superseded), logs superseded and still returns receiptId', async () => {
      vi.mocked(store.updateOcrResultCas).mockResolvedValue(false);
      const ctx = makeContext();
      const fields: ExtractedReceiptFields = {
        merchant: null,
        date: null,
        currency: null,
        total: null,
      };
      const client = fakeClient();
      const result = await handler.persist(ctx, fields, client);
      expect(result).toBe('receipt-1');
      expect(logMessages.some((m) => m.includes('superseded'))).toBe(true);
    });
  });

  describe('telemetry redaction', () => {
    it('does not log file names, storage paths, raw OCR text, or financial amounts', async () => {
      const ctx = makeContext();
      const client = fakeClient();
      const binding = makeBinding();
      const signal = new AbortController().signal;

      await handler.compute(ctx, client);
      await handler.download(ctx, binding, 5000, signal);
      await handler.ocr(ctx, Buffer.from('data'), 5000, signal);
      vi.mocked(store.updateOcrResultCas).mockResolvedValue(false);
      await handler.persist(
        ctx,
        {
          merchant: { value: 'Tienda', confidence: 0.9 },
          date: null,
          currency: null,
          total: { value: 45000, confidence: 0.85 },
        },
        client,
      );

      const allLogs = logMessages.join('\n');
      expect(allLogs).not.toContain('photo.jpg');
      expect(allLogs).not.toContain('workspaces/ws-1/receipts');
      expect(allLogs).not.toContain('STORE NAME');
      expect(allLogs).not.toContain('Tienda');
      expect(allLogs).not.toContain('45000');
    });
  });
});
