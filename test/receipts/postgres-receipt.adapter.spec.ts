import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { UUID_PATTERN } from '../../src/platform/uuid.js';
import {
  RECEIPT_PROCESSING_LOCATIONS,
  RECEIPT_PROCESSING_PREFERENCES,
  RECEIPT_STATUSES,
  type ReceiptUploadCommand,
} from '../../src/receipts/receipt.port.js';
import { PostgresReceiptAdapter } from '../../src/receipts/postgres-receipt.adapter.js';

describe('PostgresReceiptAdapter', () => {
  const workspaceId = '11111111-2222-4000-8000-000000000001';
  const receiptId = 'aaaaaaaa-bbbb-4000-8000-000000000001';
  const subject = '55555555-6666-4000-8000-000000000005';
  const transactionId = 'cccccccc-dddd-4000-8000-000000000001';
  const storagePath = `workspaces/${workspaceId}/receipts/${receiptId}/receipt.pdf`;

  const sampleDate = new Date('2026-09-07T12:00:00.000Z');

  describe('createId', () => {
    it('generates a valid UUID string', () => {
      const adapter = new PostgresReceiptAdapter();
      const id = adapter.createId();
      expect(typeof id).toBe('string');
      expect(UUID_PATTERN.test(id)).toBe(true);
    });
  });

  describe('create', () => {
    it('maps device_result preference to device location and awaiting_review status', async () => {
      let capturedQuery = '';
      let capturedParams: unknown[] = [];
      const mockClient = {
        query: vi.fn(async (text: string, params: unknown[]) => {
          capturedQuery = text;
          capturedParams = params;
          return {
            rows: [
              {
                id: receiptId,
                status: RECEIPT_STATUSES.AWAITING_REVIEW,
                fileName: 'receipt.pdf',
                processingLocation: RECEIPT_PROCESSING_LOCATIONS.DEVICE,
                merchant: { value: 'Shop', confidence: 0.9 },
                date: null,
                currency: null,
                total: null,
                transactionId: null,
                createdAt: sampleDate,
              },
            ],
          };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const command: ReceiptUploadCommand = {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('pdf data'),
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT,
        deviceOcrResult: { merchant: { value: 'Shop', confidence: 0.9 } },
      };

      const result = await adapter.create(
        mockClient,
        workspaceId,
        subject,
        receiptId,
        command,
        storagePath,
      );

      expect(result.status).toBe(RECEIPT_STATUSES.AWAITING_REVIEW);
      expect(result.processingLocation).toBe(
        RECEIPT_PROCESSING_LOCATIONS.DEVICE,
      );
      expect(result.createdAt).toBe(sampleDate.toISOString());
      expect(capturedQuery).toMatch(/insert into public\.receipts/i);
      expect(capturedParams[2]).toBe(RECEIPT_STATUSES.AWAITING_REVIEW);
      expect(capturedParams[4]).toBe(RECEIPT_PROCESSING_LOCATIONS.DEVICE);
    });

    it('maps savia preference to savia location and uploaded status', async () => {
      let capturedParams: unknown[] = [];
      const mockClient = {
        query: vi.fn(async (_text: string, params: unknown[]) => {
          capturedParams = params;
          return {
            rows: [
              {
                id: receiptId,
                status: RECEIPT_STATUSES.UPLOADED,
                fileName: 'receipt.pdf',
                processingLocation: RECEIPT_PROCESSING_LOCATIONS.SAVIA,
                merchant: null,
                date: null,
                currency: null,
                total: null,
                transactionId: null,
                createdAt: sampleDate,
              },
            ],
          };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const command: ReceiptUploadCommand = {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('pdf data'),
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
        deviceOcrResult: null,
      };

      const result = await adapter.create(
        mockClient,
        workspaceId,
        subject,
        receiptId,
        command,
        storagePath,
      );

      expect(result.status).toBe(RECEIPT_STATUSES.UPLOADED);
      expect(result.processingLocation).toBe(
        RECEIPT_PROCESSING_LOCATIONS.SAVIA,
      );
      expect(capturedParams[2]).toBe(RECEIPT_STATUSES.UPLOADED);
      expect(capturedParams[4]).toBe(RECEIPT_PROCESSING_LOCATIONS.SAVIA);
    });

    it('maps external_provider preference to external_provider location and uploaded status', async () => {
      let capturedParams: unknown[] = [];
      const mockClient = {
        query: vi.fn(async (_text: string, params: unknown[]) => {
          capturedParams = params;
          return {
            rows: [
              {
                id: receiptId,
                status: RECEIPT_STATUSES.UPLOADED,
                fileName: 'receipt.pdf',
                processingLocation:
                  RECEIPT_PROCESSING_LOCATIONS.EXTERNAL_PROVIDER,
                merchant: null,
                date: null,
                currency: null,
                total: null,
                transactionId: null,
                createdAt: sampleDate,
              },
            ],
          };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const command: ReceiptUploadCommand = {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        bytes: Buffer.from('pdf data'),
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.EXTERNAL_PROVIDER,
        deviceOcrResult: null,
      };

      const result = await adapter.create(
        mockClient,
        workspaceId,
        subject,
        receiptId,
        command,
        storagePath,
      );

      expect(result.status).toBe(RECEIPT_STATUSES.UPLOADED);
      expect(result.processingLocation).toBe(
        RECEIPT_PROCESSING_LOCATIONS.EXTERNAL_PROVIDER,
      );
      expect(capturedParams[2]).toBe(RECEIPT_STATUSES.UPLOADED);
      expect(capturedParams[4]).toBe(
        RECEIPT_PROCESSING_LOCATIONS.EXTERNAL_PROVIDER,
      );
    });
  });

  describe('find', () => {
    it('returns mapped receipt when found', async () => {
      const mockClient = {
        query: vi.fn(async () => ({
          rows: [
            {
              id: receiptId,
              status: RECEIPT_STATUSES.UPLOADED,
              fileName: 'receipt.pdf',
              processingLocation: RECEIPT_PROCESSING_LOCATIONS.SAVIA,
              merchant: null,
              date: null,
              currency: null,
              total: null,
              transactionId: null,
              createdAt: sampleDate,
            },
          ],
        })),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const result = await adapter.find(mockClient, workspaceId, receiptId);

      expect(result).toBeDefined();
      expect(result?.id).toBe(receiptId);
      expect(result?.status).toBe(RECEIPT_STATUSES.UPLOADED);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /select[\s\S]*from public\.receipts where workspace_id = \$1::uuid and id = \$2::uuid/i,
        ),
        [workspaceId, receiptId],
      );
    });

    it('returns undefined when receipt not found', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rows: [] })),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const result = await adapter.find(mockClient, workspaceId, receiptId);

      expect(result).toBeUndefined();
    });
  });

  describe('claim — preconditions and return value', () => {
    it('returns true when claim update matches and updates exactly 1 row', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rowCount: 1 })),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const result = await adapter.claim(mockClient, workspaceId, receiptId);

      expect(result).toBe(true);
    });

    it('returns false when claim update matches 0 rows (precondition unsatisfied or not found)', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rowCount: 0 })),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const result = await adapter.claim(mockClient, workspaceId, receiptId);

      expect(result).toBe(false);
    });

    it('claim SQL query specifies workspace_id precondition in WHERE clause', async () => {
      let queryText = '';
      const mockClient = {
        query: vi.fn(async (text: string) => {
          queryText = text;
          return { rowCount: 1 };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      await adapter.claim(mockClient, workspaceId, receiptId);

      expect(queryText).toContain('workspace_id = $1::uuid');
    });

    it('claim SQL query specifies receipt id precondition in WHERE clause', async () => {
      let queryText = '';
      const mockClient = {
        query: vi.fn(async (text: string) => {
          queryText = text;
          return { rowCount: 1 };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      await adapter.claim(mockClient, workspaceId, receiptId);

      expect(queryText).toContain('id = $2::uuid');
    });

    it('claim SQL query specifies status in (uploaded, awaiting_review) precondition in WHERE clause', async () => {
      let queryText = '';
      const mockClient = {
        query: vi.fn(async (text: string) => {
          queryText = text;
          return { rowCount: 1 };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      await adapter.claim(mockClient, workspaceId, receiptId);

      expect(queryText).toContain("status in ('uploaded', 'awaiting_review')");
    });

    it('claim SQL query specifies transaction_id is null precondition in WHERE clause', async () => {
      let queryText = '';
      const mockClient = {
        query: vi.fn(async (text: string) => {
          queryText = text;
          return { rowCount: 1 };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      await adapter.claim(mockClient, workspaceId, receiptId);

      expect(queryText).toContain('transaction_id is null');
    });

    it('claim SQL query passes workspaceId and id as query parameters', async () => {
      let queryParams: unknown[] = [];
      const mockClient = {
        query: vi.fn(async (_text: string, params: unknown[]) => {
          queryParams = params;
          return { rowCount: 1 };
        }),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      await adapter.claim(mockClient, workspaceId, receiptId);

      expect(queryParams).toEqual([workspaceId, receiptId]);
    });
  });

  describe('confirm — parameters and return value', () => {
    it('returns true when confirm update matches and updates exactly 1 row', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rowCount: 1 })),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const result = await adapter.confirm(
        mockClient,
        workspaceId,
        receiptId,
        transactionId,
      );

      expect(result).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /update public\.receipts set status = 'confirmed', transaction_id = \$3::uuid[\s\S]*where workspace_id = \$1::uuid and id = \$2::uuid/i,
        ),
        [workspaceId, receiptId, transactionId],
      );
    });

    it('returns false when confirm update matches 0 rows', async () => {
      const mockClient = {
        query: vi.fn(async () => ({ rowCount: 0 })),
      } as unknown as TransactionClient;

      const adapter = new PostgresReceiptAdapter();
      const result = await adapter.confirm(
        mockClient,
        workspaceId,
        receiptId,
        transactionId,
      );

      expect(result).toBe(false);
    });
  });
});
