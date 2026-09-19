import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import type { OcrEnginePort } from '../../src/platform/ocr-engine.port.js';
import type { JobExecutionContext } from '../../src/platform/job-handler.port.js';
import { PostgresReceiptAdapter } from '../../src/receipts/postgres-receipt.adapter.js';
import {
  type ReceiptOcrBinding,
  type ReceiptOcrJobPayload,
} from '../../src/receipts/receipt.port.js';
import {
  ReceiptOcrJobHandler,
  ReceiptOcrPayloadError,
} from '../../src/receipts/receipt-ocr-job.handler.js';

const WORKSPACE_ID = '11111111-2222-4000-8000-000000000001';
const OTHER_WORKSPACE_ID = '99999999-2222-4000-8000-000000000099';
const RECEIPT_ID = 'aaaaaaaa-bbbb-4000-8000-000000000001';
const JOB_ID = 'cccccccc-dddd-4000-8000-000000000001';
const ACTOR_ID = '55555555-6666-4000-8000-000000000005';

const OWN_ROW: ReceiptOcrBinding = {
  id: RECEIPT_ID,
  workspaceId: WORKSPACE_ID,
  storagePath: `workspaces/${WORKSPACE_ID}/receipts/${RECEIPT_ID}/photo.jpg`,
  jobId: JOB_ID,
  createdBy: ACTOR_ID,
  status: 'uploaded',
  transactionId: null,
};

const OTHER_WORKSPACE_ROW: ReceiptOcrBinding = {
  ...OWN_ROW,
  workspaceId: OTHER_WORKSPACE_ID,
  storagePath: `workspaces/${OTHER_WORKSPACE_ID}/receipts/${RECEIPT_ID}/photo.jpg`,
};

function makeContext(): JobExecutionContext<ReceiptOcrJobPayload> {
  return {
    jobId: JOB_ID,
    workspaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    attemptCount: 1,
    payload: {
      receiptId: RECEIPT_ID,
      storagePath: OWN_ROW.storagePath,
    },
  };
}

describe('ReceiptStoreBinding (findOcrBinding)', () => {
  it('returns binding with id, workspaceId, storagePath, jobId, createdBy, status, transactionId', async () => {
    const adapter = new PostgresReceiptAdapter();
    const client = {
      query: vi.fn(async () => ({ rows: [OWN_ROW], rowCount: 1 })),
    } as unknown as TransactionClient;

    const result = await adapter.findOcrBinding(
      client,
      WORKSPACE_ID,
      RECEIPT_ID,
      JOB_ID,
    );

    expect(result).toEqual(OWN_ROW);
    const sql = String(vi.mocked(client.query).mock.calls[0]?.[0]);
    expect(sql).toMatch(/workspace_id\s*=\s*\$1/i);
    expect(sql).toMatch(/r\.id\s*=\s*\$2/i);
    expect(sql).toMatch(/job_id\s*=\s*\$3/i);
    expect(vi.mocked(client.query).mock.calls[0]?.[1]).toEqual([
      WORKSPACE_ID,
      RECEIPT_ID,
      JOB_ID,
    ]);
  });

  it('returns null when receipt does not exist — handler throws orphaned', async () => {
    const adapter = new PostgresReceiptAdapter();
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as TransactionClient;
    const downloadFn = vi.fn();
    const recognizeFn = vi.fn();
    const handler = new ReceiptOcrJobHandler(
      adapter,
      { download: downloadFn } as unknown as ArtifactStorage,
      { recognize: recognizeFn } as unknown as OcrEnginePort,
    );

    await expect(handler.compute(makeContext(), client)).rejects.toThrow(
      ReceiptOcrPayloadError,
    );
    expect(downloadFn).not.toHaveBeenCalled();
    expect(recognizeFn).not.toHaveBeenCalled();
  });

  it('returns null when workspace does not match — handler throws orphaned', async () => {
    const adapter = new PostgresReceiptAdapter();
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (!/workspace_id\s*=\s*\$1/i.test(sql)) {
          return { rows: [OWN_ROW], rowCount: 1 };
        }
        if (params[0] !== WORKSPACE_ID) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [OWN_ROW], rowCount: 1 };
      }),
    } as unknown as TransactionClient;
    const handler = new ReceiptOcrJobHandler(
      adapter,
      {} as ArtifactStorage,
      {} as OcrEnginePort,
    );

    await expect(
      handler.compute(
        { ...makeContext(), workspaceId: OTHER_WORKSPACE_ID },
        client,
      ),
    ).rejects.toThrow(ReceiptOcrPayloadError);
  });

  it('creator RLS: query under demoted creator returns null (zero rows) with no I/O', async () => {
    const adapter = new PostgresReceiptAdapter();
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as TransactionClient;
    const downloadFn = vi.fn();
    const recognizeFn = vi.fn();
    const handler = new ReceiptOcrJobHandler(
      adapter,
      { download: downloadFn } as unknown as ArtifactStorage,
      { recognize: recognizeFn } as unknown as OcrEnginePort,
    );

    await expect(handler.compute(makeContext(), client)).rejects.toThrow(
      ReceiptOcrPayloadError,
    );
    expect(downloadFn).not.toHaveBeenCalled();
    expect(recognizeFn).not.toHaveBeenCalled();
  });

  it('does not return another workspace row from findOcrBinding', async () => {
    const adapter = new PostgresReceiptAdapter();
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        const catalog = [OTHER_WORKSPACE_ROW, OWN_ROW];
        if (!/workspace_id\s*=\s*\$1/i.test(sql)) {
          return { rows: catalog, rowCount: catalog.length };
        }
        const filtered = catalog.filter((row) => row.workspaceId === params[0]);
        return { rows: filtered, rowCount: filtered.length };
      }),
    } as unknown as TransactionClient;

    const result = await adapter.findOcrBinding(
      client,
      WORKSPACE_ID,
      RECEIPT_ID,
      JOB_ID,
    );

    expect(result).not.toBeNull();
    expect(result?.workspaceId).toBe(WORKSPACE_ID);
    expect(result?.workspaceId).not.toBe(OTHER_WORKSPACE_ID);
  });
});
