import { describe, expect, it } from 'vitest';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type {
  CreateTransactionCommand,
  LedgerWriter,
} from '../../src/platform/ledger-writer.port.js';
import {
  TRANSACTION_CREATE_OUTCOMES,
  type Transaction,
  type TransactionCreateOutcome,
} from '../../src/ledger/ledger.port.js';
import type {
  JobRecord,
  JobWriter,
  JobWriterType,
} from '../../src/platform/job-writer.port.js';
import { JOB_WRITER_TYPES } from '../../src/platform/job-writer.port.js';
import {
  RECEIPT_OUTCOMES,
  RECEIPT_PROCESSING_PREFERENCES,
  RECEIPT_STATUSES,
  type Receipt,
  type ReceiptStore,
  type ReceiptUploadCommand,
} from '../../src/receipts/receipt.port.js';
import {
  ReceiptService,
  type ReceiptTransaction,
} from '../../src/receipts/receipt.service.js';

class RecordingTransaction implements ReceiptTransaction {
  public committed = 0;
  public rolledBack = 0;
  // ReceiptService.readRole issues a real query against the client, so the
  // double must answer it. Making the role configurable here is what lets these
  // tests drive the authorization branches without a database.
  public role: string | null = 'owner';

  private client(): TransactionClient {
    return {
      query: async () => ({ rows: [{ role: this.role }] }),
    } as unknown as TransactionClient;
  }

  public async run<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    void _subject;
    try {
      const result = await callback(this.client());
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }

  public async runRead<T>(
    _subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    void _subject;
    try {
      const result = await callback(this.client());
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }
}

class FakeReceiptStore implements ReceiptStore {
  public createdId = 'aaaaaaaa-bbbb-4000-8000-000000000001';
  public claimResult = true;
  public confirmResult = true;
  public findResult: Receipt | undefined = undefined;
  public createResult: Receipt | undefined = undefined;
  public createError: Error | null = null;
  public claimCalls: Array<{ workspaceId: string; id: string }> = [];
  public confirmCalls: Array<{
    workspaceId: string;
    id: string;
    transactionId: string;
  }> = [];
  public createCalls: unknown[] = [];

  public createId(): string {
    return this.createdId;
  }

  public async create(
    _client: TransactionClient,
    workspaceId: string,
    _subject: string,
    id: string,
    command: ReceiptUploadCommand,
    storagePath: string,
    jobId?: string,
  ): Promise<Receipt> {
    this.createCalls.push({ workspaceId, id, command, storagePath, jobId });
    if (this.createError) throw this.createError;
    return (
      this.createResult ?? {
        id,
        status: RECEIPT_STATUSES.UPLOADED,
        fileName: command.fileName,
        processingLocation: 'savia',
        merchant: null,
        date: null,
        currency: null,
        total: null,
        transactionId: null,
        createdAt: '2026-09-07T12:00:00.000Z',
      }
    );
  }

  public async find(
    _client: TransactionClient,
    _workspaceId: string,
    _id: string,
  ): Promise<Receipt | undefined> {
    void _client;
    void _workspaceId;
    void _id;
    return this.findResult;
  }

  public async claim(
    _client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    this.claimCalls.push({ workspaceId, id });
    return this.claimResult;
  }

  public async confirm(
    _client: TransactionClient,
    workspaceId: string,
    id: string,
    transactionId: string,
  ): Promise<boolean> {
    this.confirmCalls.push({ workspaceId, id, transactionId });
    return this.confirmResult;
  }

  public async findOcrBinding(): Promise<null> {
    return null;
  }

  public async updateOcrResultCas(): Promise<boolean> {
    return false;
  }
}

class FakeIdempotencyStore implements IdempotencyStore {
  public records = new Map<string, IdempotencyRecord>();
  public writeCalls: Array<{ key: string; fingerprint: string }> = [];

  public async read(
    _client: TransactionClient,
    subject: string,
    route: string,
    key: string,
    workspaceId?: string,
  ): Promise<IdempotencyRecord | undefined> {
    void _client;
    return this.records.get(`${subject}:${workspaceId ?? ''}:${route}:${key}`);
  }

  public async write(
    _client: TransactionClient,
    subject: string,
    route: string,
    key: string,
    fingerprint: string,
    status: number,
    etag: string | null,
    body: unknown,
    workspaceId?: string,
  ): Promise<boolean> {
    void _client;
    this.writeCalls.push({ key, fingerprint });
    this.records.set(`${subject}:${workspaceId ?? ''}:${route}:${key}`, {
      requestFingerprint: fingerprint,
      responseStatus: status,
      responseEtag: etag,
      responseBody: body,
    });
    return true;
  }
}

class FakeArtifactStorage implements ArtifactStorage {
  public uploadCalls: Array<{
    path: string;
    bytes: Buffer;
    contentType: string;
  }> = [];
  public removeCalls: string[] = [];

  public async upload(
    path: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    this.uploadCalls.push({ path, bytes, contentType });
  }

  public async remove(path: string): Promise<void> {
    this.removeCalls.push(path);
  }

  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    void path;
    return { url: 'https://example.com/signed', expiresAt };
  }

  public async download(path: string): Promise<Buffer> {
    const found = this.uploadCalls.find((call) => call.path === path);
    return found ? found.bytes : Buffer.alloc(0);
  }
}

class FakeLedgerWriter implements LedgerWriter {
  public transaction: Transaction = {
    id: 'cccccccc-dddd-4000-8000-000000000001',
    type: 'expense',
    status: 'confirmed',
    accountId: '22222222-3333-4000-8000-000000000002',
    amount: { amountMinor: '1000', currency: 'USD' },
    occurredAt: '2026-09-07T12:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: null,
    tagIds: [],
    receiptId: 'aaaaaaaa-bbbb-4000-8000-000000000001',
    reconciliationId: null,
    version: 1,
    createdAt: '2026-09-07T12:00:00.000Z',
    updatedAt: '2026-09-07T12:00:00.000Z',
  };

  public transactionResult: TransactionCreateOutcome = {
    kind: TRANSACTION_CREATE_OUTCOMES.CREATED,
    transaction: this.transaction,
  };
  public calls: unknown[] = [];

  public async createTransaction(
    _client: TransactionClient,
    subject: string,
    workspaceId: string,
    command: CreateTransactionCommand,
    idempotencyKey: string,
  ): Promise<TransactionCreateOutcome> {
    this.calls.push({ subject, workspaceId, command, idempotencyKey });
    return this.transactionResult;
  }

  // These three satisfy the LedgerWriter interface structurally and are never
  // exercised by these tests. TypeScript lets an implementation declare fewer
  // parameters than its interface, which is how the repo avoids unused-argument
  // lint errors without loosening the eslint config.
  public async createAdjustmentTransaction(): Promise<void> {}

  public async createImportedTransaction(): Promise<unknown> {
    return {};
  }

  public async createImportedTransactions(): Promise<void> {}

  public async voidTransaction(): Promise<unknown> {
    return {};
  }
}

class FakeJobWriter implements JobWriter {
  public queuedJobs: Array<{
    workspaceId: string;
    subject: string;
    type: JobWriterType;
    payload: Record<string, unknown> | null;
  }> = [];

  public async createQueuedJob(
    _client: TransactionClient,
    workspaceId: string,
    subject: string,
    type: JobWriterType,
    payload?: Record<string, unknown> | null,
  ): Promise<JobRecord> {
    this.queuedJobs.push({
      workspaceId,
      subject,
      type,
      payload: payload ?? null,
    });
    return {
      id: 'jjjjjjjj-kkkk-4000-8000-000000000001',
      type,
      status: 'queued',
      progressPercent: null,
      resultResourceId: null,
      error: null,
      createdAt: '2026-09-17T12:00:00.000Z',
      startedAt: null,
      completedAt: null,
    };
  }

  public async createTerminalJob(): Promise<Record<string, unknown>> {
    return {};
  }
  public async transitionToProcessing(): Promise<Record<string, unknown>> {
    return {};
  }
  public async completeJob(): Promise<Record<string, unknown>> {
    return {};
  }
  public async failJob(): Promise<Record<string, unknown>> {
    return {};
  }
  public async deadLetter(): Promise<Record<string, unknown>> {
    return {};
  }
  public async findJobById(): Promise<{ readonly status: string } | undefined> {
    return undefined;
  }
}

const WORKSPACE = '11111111-2222-4000-8000-000000000001';
const SUBJECT = '00000000-0000-0000-0000-000000000001';
const RECEIPT_ID = 'aaaaaaaa-bbbb-4000-8000-000000000001';
const KEY = 'idem-key-0000000000000001';

interface Harness {
  readonly tx: RecordingTransaction;
  readonly store: FakeReceiptStore;
  readonly idempotency: FakeIdempotencyStore;
  readonly storage: FakeArtifactStorage;
  readonly ledgerWriter: FakeLedgerWriter;
  readonly jobWriter: FakeJobWriter;
  readonly service: ReceiptService;
}

function harness(): Harness {
  const tx = new RecordingTransaction();
  const store = new FakeReceiptStore();
  const idempotency = new FakeIdempotencyStore();
  const storage = new FakeArtifactStorage();
  const ledgerWriter = new FakeLedgerWriter();
  const jobWriter = new FakeJobWriter();
  return {
    tx,
    store,
    idempotency,
    storage,
    ledgerWriter,
    jobWriter,
    service: new ReceiptService(
      tx,
      store,
      idempotency,
      storage,
      ledgerWriter,
      jobWriter,
    ),
  };
}

function upload(
  overrides: Partial<ReceiptUploadCommand> = {},
): ReceiptUploadCommand {
  return {
    fileName: 'receipt.pdf',
    contentType: 'application/pdf',
    bytes: Buffer.from('receipt-bytes'),
    processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
    deviceOcrResult: null,
    ...overrides,
  };
}

function transactionCommand(): CreateTransactionCommand {
  return {
    type: 'expense',
    accountId: '22222222-3333-4000-8000-000000000002',
    amount: { amountMinor: '1000', currency: 'USD' },
    occurredAt: '2026-09-07T12:00:00.000Z',
    status: 'confirmed',
  } as CreateTransactionCommand;
}

describe('ReceiptService.createReceipt', () => {
  it('refuses a subject with no active role and never touches storage', async () => {
    const h = harness();
    h.tx.role = null;

    const outcome = await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.FORBIDDEN);
    expect(h.storage.uploadCalls).toHaveLength(0);
    expect(h.store.createCalls).toHaveLength(0);
  });

  it('refuses a viewer, who may read but not upload', async () => {
    const h = harness();
    h.tx.role = 'viewer';

    const outcome = await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.FORBIDDEN);
    expect(h.storage.uploadCalls).toHaveLength(0);
  });

  it('accepts owner, administrator and editor', async () => {
    for (const role of ['owner', 'administrator', 'editor']) {
      const h = harness();
      h.tx.role = role;

      const outcome = await h.service.createReceipt(
        SUBJECT,
        WORKSPACE,
        upload(),
        KEY,
      );

      expect(outcome.kind).toBe(RECEIPT_OUTCOMES.CREATED);
    }
  });

  it('stores the file under a workspace-scoped and receipt-scoped path', async () => {
    const h = harness();

    await h.service.createReceipt(SUBJECT, WORKSPACE, upload(), KEY);

    expect(h.storage.uploadCalls).toHaveLength(1);
    expect(h.storage.uploadCalls[0]?.path).toBe(
      `workspaces/${WORKSPACE}/receipts/${RECEIPT_ID}/receipt.pdf`,
    );
    expect(h.storage.uploadCalls[0]?.contentType).toBe('application/pdf');
  });

  it('writes an idempotency record carrying the 202 the contract declares', async () => {
    const h = harness();

    await h.service.createReceipt(SUBJECT, WORKSPACE, upload(), KEY);

    expect(h.idempotency.writeCalls).toHaveLength(1);
    const stored = h.idempotency.records.get(
      `${SUBJECT}:${WORKSPACE}:POST /v1/receipts:${KEY}`,
    );
    expect(stored?.responseStatus).toBe(202);
  });

  it('replays the stored response when the same key carries the same request', async () => {
    const h = harness();
    const command = upload();

    const first = await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      command,
      KEY,
    );
    expect(first.kind).toBe(RECEIPT_OUTCOMES.CREATED);

    const replay = await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      command,
      KEY,
    );

    expect(replay.kind).toBe(RECEIPT_OUTCOMES.TRANSACTION_REPLAYED);
    expect(h.storage.uploadCalls).toHaveLength(1);
    expect(h.store.createCalls).toHaveLength(1);
  });

  it('conflicts when the same key carries a different request', async () => {
    const h = harness();

    await h.service.createReceipt(SUBJECT, WORKSPACE, upload(), KEY);
    const outcome = await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({ fileName: 'other.pdf' }),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.CONFLICT);
    expect(h.store.createCalls).toHaveLength(1);
  });

  it('fingerprints the file bytes, so identical names with different content conflict', async () => {
    const h = harness();

    await h.service.createReceipt(SUBJECT, WORKSPACE, upload(), KEY);
    const outcome = await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({ bytes: Buffer.from('different-bytes') }),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.CONFLICT);
  });

  it('removes the stored object when the row write fails, leaving no orphan', async () => {
    const h = harness();
    h.store.createError = new Error('row write failed');

    await expect(
      h.service.createReceipt(SUBJECT, WORKSPACE, upload(), KEY),
    ).rejects.toThrow('row write failed');

    expect(h.storage.removeCalls).toEqual([
      `workspaces/${WORKSPACE}/receipts/${RECEIPT_ID}/receipt.pdf`,
    ]);
  });

  it('rolls back rather than commits when the row write throws (RULING 92)', async () => {
    const h = harness();
    h.store.createError = new Error('row write failed');

    await expect(
      h.service.createReceipt(SUBJECT, WORKSPACE, upload(), KEY),
    ).rejects.toThrow();

    expect(h.tx.rolledBack).toBe(1);
    expect(h.tx.committed).toBe(0);
  });

  it('enqueues receipt_ocr job and links jobId when uploading JPEG image with savia preference', async () => {
    const h = harness();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({
        fileName: 'receipt.jpg',
        contentType: 'image/jpeg',
        bytes: jpegBytes,
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      }),
      KEY,
    );

    expect(h.jobWriter.queuedJobs).toHaveLength(1);
    expect(h.jobWriter.queuedJobs[0]).toEqual({
      workspaceId: WORKSPACE,
      subject: SUBJECT,
      type: JOB_WRITER_TYPES.RECEIPT_OCR,
      payload: {
        receiptId: RECEIPT_ID,
        storagePath: `workspaces/${WORKSPACE}/receipts/${RECEIPT_ID}/receipt.jpg`,
      },
    });

    expect(h.store.createCalls).toHaveLength(1);
    expect((h.store.createCalls[0] as { jobId?: string }).jobId).toBe(
      'jjjjjjjj-kkkk-4000-8000-000000000001',
    );
  });

  it('enqueues receipt_ocr job and links jobId when uploading PNG image with savia preference', async () => {
    const h = harness();
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({
        fileName: 'receipt.png',
        contentType: 'image/png',
        bytes: pngBytes,
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      }),
      KEY,
    );

    expect(h.jobWriter.queuedJobs).toHaveLength(1);
    expect((h.store.createCalls[0] as { jobId?: string }).jobId).toBe(
      'jjjjjjjj-kkkk-4000-8000-000000000001',
    );
  });

  it('enqueues receipt_ocr job and links jobId when uploading WebP image with savia preference', async () => {
    const h = harness();
    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);

    await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({
        fileName: 'receipt.webp',
        contentType: 'image/webp',
        bytes: webpBytes,
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      }),
      KEY,
    );

    expect(h.jobWriter.queuedJobs).toHaveLength(1);
    expect((h.store.createCalls[0] as { jobId?: string }).jobId).toBe(
      'jjjjjjjj-kkkk-4000-8000-000000000001',
    );
  });

  it('does not enqueue a job for PDF bytes with savia preference, passing undefined jobId', async () => {
    const h = harness();
    const pdfBytes = Buffer.from('%PDF-1.7 mock document');

    await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({
        fileName: 'document.pdf',
        contentType: 'application/pdf',
        bytes: pdfBytes,
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      }),
      KEY,
    );

    expect(h.jobWriter.queuedJobs).toHaveLength(0);
    expect(h.store.createCalls).toHaveLength(1);
    expect(
      (h.store.createCalls[0] as { jobId?: string }).jobId,
    ).toBeUndefined();
  });

  it('does not enqueue a job for arbitrary text bytes with spoofed image/jpeg MIME', async () => {
    const h = harness();
    const textBytes = Buffer.from('Plain text content');

    await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({
        fileName: 'fake.jpg',
        contentType: 'image/jpeg',
        bytes: textBytes,
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.SAVIA,
      }),
      KEY,
    );

    expect(h.jobWriter.queuedJobs).toHaveLength(0);
    expect(h.store.createCalls).toHaveLength(1);
    expect(
      (h.store.createCalls[0] as { jobId?: string }).jobId,
    ).toBeUndefined();
  });

  it('does not enqueue a job when preference is device_result', async () => {
    const h = harness();
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    await h.service.createReceipt(
      SUBJECT,
      WORKSPACE,
      upload({
        fileName: 'device.jpg',
        contentType: 'image/jpeg',
        bytes: jpegBytes,
        processingPreference: RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT,
        deviceOcrResult: { merchant: { value: 'Store', confidence: 1 } },
      }),
      KEY,
    );

    expect(h.jobWriter.queuedJobs).toHaveLength(0);
    expect(h.store.createCalls).toHaveLength(1);
    expect(
      (h.store.createCalls[0] as { jobId?: string }).jobId,
    ).toBeUndefined();
  });
});

describe('ReceiptService.getReceipt', () => {
  it('refuses a non-member', async () => {
    const h = harness();
    h.tx.role = null;

    const outcome = await h.service.getReceipt(SUBJECT, WORKSPACE, RECEIPT_ID);

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.FORBIDDEN);
  });

  it('allows a viewer to read, unlike upload', async () => {
    const h = harness();
    h.tx.role = 'viewer';
    h.store.findResult = {
      id: RECEIPT_ID,
      status: RECEIPT_STATUSES.UPLOADED,
      fileName: 'receipt.pdf',
      processingLocation: 'savia',
      merchant: null,
      date: null,
      currency: null,
      total: null,
      transactionId: null,
      createdAt: '2026-09-07T12:00:00.000Z',
    };

    const outcome = await h.service.getReceipt(SUBJECT, WORKSPACE, RECEIPT_ID);

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.FOUND);
  });

  it('answers not found when the row is absent or belongs to another workspace', async () => {
    const h = harness();
    h.store.findResult = undefined;

    const outcome = await h.service.getReceipt(SUBJECT, WORKSPACE, RECEIPT_ID);

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.NOT_FOUND);
  });
});

describe('ReceiptService.confirmReceipt', () => {
  it('refuses a viewer before claiming anything', async () => {
    const h = harness();
    h.tx.role = 'viewer';

    const outcome = await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.FORBIDDEN);
    expect(h.store.claimCalls).toHaveLength(0);
    expect(h.ledgerWriter.calls).toHaveLength(0);
  });

  it('claims the receipt BEFORE writing to the ledger, so a lost race writes nothing', async () => {
    const h = harness();
    h.store.claimResult = false;
    h.store.findResult = {
      id: RECEIPT_ID,
      status: RECEIPT_STATUSES.CONFIRMED,
      fileName: 'receipt.pdf',
      processingLocation: 'savia',
      merchant: null,
      date: null,
      currency: null,
      total: null,
      transactionId: 'cccccccc-dddd-4000-8000-000000000001',
      createdAt: '2026-09-07T12:00:00.000Z',
    };

    const outcome = await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.CONFLICT);
    // This is the assertion that guards against financial duplication: the
    // loser of a concurrent confirm must never reach transaction creation.
    expect(h.ledgerWriter.calls).toHaveLength(0);
  });

  it('answers not found when the claim fails because no such receipt exists', async () => {
    const h = harness();
    h.store.claimResult = false;
    h.store.findResult = undefined;

    const outcome = await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.NOT_FOUND);
    expect(h.ledgerWriter.calls).toHaveLength(0);
  });

  it('creates the transaction and links it, committing once', async () => {
    const h = harness();

    const outcome = await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.CREATED);
    expect(h.store.claimCalls).toHaveLength(1);
    expect(h.ledgerWriter.calls).toHaveLength(1);
    expect(h.store.confirmCalls).toHaveLength(1);
    expect(h.store.confirmCalls[0]?.transactionId).toBe(
      'cccccccc-dddd-4000-8000-000000000001',
    );
    expect(h.tx.committed).toBe(1);
    expect(h.tx.rolledBack).toBe(0);
  });

  it('passes the receipt id down so the transaction carries it', async () => {
    const h = harness();

    await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    const call = h.ledgerWriter.calls[0] as {
      command: { receiptId?: string };
    };
    expect(call.command.receiptId).toBe(RECEIPT_ID);
  });
});

describe('ReceiptService.confirmReceipt rolls back every post-claim failure (RULING 92)', () => {
  // pg-transaction COMMITs whenever the callback RETURNS; only a THROW rolls
  // back. Each of these outcomes is produced after the claim has already
  // written, so each must reach the caller by throwing the sentinel, never by
  // returning. A returned failure would commit the claim and brick the receipt.
  const cases = [
    {
      name: 'forbidden from the ledger',
      outcome: { kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN },
      expected: RECEIPT_OUTCOMES.FORBIDDEN,
    },
    {
      name: 'idempotency conflict from the ledger',
      outcome: { kind: TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT },
      expected: RECEIPT_OUTCOMES.CONFLICT,
    },
    {
      name: 'account unresolved',
      outcome: { kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED },
      expected: RECEIPT_OUTCOMES.TRANSACTION_INVALID,
    },
    {
      name: 'account closed',
      outcome: { kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED },
      expected: RECEIPT_OUTCOMES.TRANSACTION_INVALID,
    },
  ] as const;

  for (const testCase of cases) {
    it(`rolls back on ${testCase.name}`, async () => {
      const h = harness();
      h.ledgerWriter.transactionResult =
        testCase.outcome as TransactionCreateOutcome;

      const outcome = await h.service.confirmReceipt(
        SUBJECT,
        WORKSPACE,
        RECEIPT_ID,
        transactionCommand(),
        KEY,
      );

      expect(outcome.kind).toBe(testCase.expected);
      expect(h.tx.rolledBack).toBe(1);
      expect(h.tx.committed).toBe(0);
      expect(h.store.confirmCalls).toHaveLength(0);
    });
  }

  it('rolls back when the link-back update finds no row', async () => {
    const h = harness();
    h.store.confirmResult = false;

    const outcome = await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.CONFLICT);
    expect(h.tx.rolledBack).toBe(1);
    expect(h.tx.committed).toBe(0);
  });

  it('surfaces a ledger replay without committing a second claim', async () => {
    const h = harness();
    h.ledgerWriter.transactionResult = {
      kind: TRANSACTION_CREATE_OUTCOMES.REPLAYED,
      status: 201,
      etag: '"1"',
      body: { id: 'cccccccc-dddd-4000-8000-000000000001' },
    } as TransactionCreateOutcome;

    const outcome = await h.service.confirmReceipt(
      SUBJECT,
      WORKSPACE,
      RECEIPT_ID,
      transactionCommand(),
      KEY,
    );

    expect(outcome.kind).toBe(RECEIPT_OUTCOMES.TRANSACTION_REPLAYED);
    expect(h.tx.rolledBack).toBe(1);
    expect(h.tx.committed).toBe(0);
  });
});
