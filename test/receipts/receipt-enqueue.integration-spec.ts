// Migration under test: 202609170003_receipt_ocr.sql
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import {
  ARTIFACT_STORAGE,
  ArtifactStorageUnavailableError,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
process.env.JWT_ISSUER = 'https://issuer.example.test';
process.env.JWT_AUDIENCE = 'savia-api';
process.env.JWT_JWKS_URI = 'https://issuer.example.test/jwks';
process.env.JWT_ALGORITHMS = 'RS256';

class MemoryStorage implements ArtifactStorage {
  public readonly paths: string[] = [];
  public readonly removeCalls: string[] = [];
  public unavailable = false;

  public async upload(path: string): Promise<void> {
    if (this.unavailable) {
      throw new ArtifactStorageUnavailableError('Storage upload failed.');
    }
    this.paths.push(path);
  }

  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    return { url: path, expiresAt };
  }

  public async remove(path: string): Promise<void> {
    this.removeCalls.push(path);
    const index = this.paths.indexOf(path);
    if (index !== -1) {
      this.paths.splice(index, 1);
    }
  }
}

const boundary = 'savia-receipt-enqueue-boundary';
function form(
  file: Buffer,
  name: string,
  contentType: string,
  fields: Readonly<Record<string, string>> = {},
): Buffer {
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
  ];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}`,
      ),
    );
  }
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const KNOWN_RECEIPT_SCHEMA_KEYS = new Set([
  'id',
  'status',
  'fileName',
  'processingLocation',
  'merchant',
  'date',
  'currency',
  'total',
  'transactionId',
  'createdAt',
]);

function assertClosedReceiptSchema(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    expect(
      KNOWN_RECEIPT_SCHEMA_KEYS.has(key),
      `Unexpected key "${key}" found in closed Receipt response body.`,
    ).toBe(true);
  }
  expect(body).not.toHaveProperty('jobId');
  expect(body).not.toHaveProperty('job_id');
  expect(body).not.toHaveProperty('error');
}

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20,
]);
const PDF_BYTES = Buffer.from('%PDF-1.7 mock receipt content');
const SPOOFED_MIME_BYTES = Buffer.from('Plain text claiming to be an image');

describe('Receipt upload classification and transactional enqueue', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  const subject = '00000000-0000-4000-8000-000000009951';
  let workspace: string;
  let account: string;
  let storage: MemoryStorage;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id, email) values ($1, 'receipt-enqueue-owner@test') on conflict (id) do nothing`,
      [subject],
    );
    await admin.query(
      `insert into public.profiles (
         id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency
       ) values (
         $1, 'receipt-enqueue-owner@test', 'Receipt Enqueue Owner', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD'
       ) on conflict (id) do nothing`,
      [subject],
    );

    storage = new MemoryStorage();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) =>
          token === 'owner'
            ? { subject }
            : Promise.reject(new Error('rejected')),
      })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(storage)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app
      .getHttpAdapter()
      .getInstance()
      .register(multipart, {
        limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
        throwFileSizeLimit: false,
      });
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    storage.unavailable = false;
    storage.paths.length = 0;
    storage.removeCalls.length = 0;
    workspace = randomUUID();
    account = randomUUID();
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency) values ($1, 'Receipt Enqueue Workspace', 'shared', 'USD')`,
      [workspace],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
      [workspace, subject],
    );
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by) values ($1, $2, 'Checking Account', 'checking', 'USD', 'active', $3)`,
      [account, workspace, subject],
    );
  });

  afterEach(async () => {
    await admin.query('delete from public.workspaces where id = $1', [
      workspace,
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await admin.query('delete from auth.users where id = $1', [subject]);
    await admin.end();
  });

  async function upload(
    key = randomUUID(),
    fields: Readonly<Record<string, string>> = {},
    content = JPEG_BYTES,
    name = 'receipt.jpg',
    contentType = 'image/jpeg',
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/receipts',
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': key,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: form(content, name, contentType, fields),
    });
  }

  it.each([
    ['image/jpeg', 'receipt.jpg', JPEG_BYTES],
    ['image/png', 'receipt.png', PNG_BYTES],
    ['image/webp', 'receipt.webp', WEBP_BYTES],
  ])(
    'enqueues receipt_ocr job in single tx.run for %s with processingPreference: savia',
    async (mime, fileName, bytes) => {
      const response = await upload(
        randomUUID(),
        { processingPreference: 'savia' },
        bytes,
        fileName,
        mime,
      );
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload);

      // Verify closed OpenAPI Receipt schema: strictly NO jobId, job_id, or error in HTTP response
      assertClosedReceiptSchema(body);
      expect(body.status).toBe('uploaded');
      expect(body.processingLocation).toBe('savia');

      // Assert linkage and outbox row through direct DB query
      const receiptRes = await admin.query<{
        id: string;
        job_id: string | null;
        status: string;
        transaction_id: string | null;
      }>(
        `select id::text, job_id::text, status, transaction_id::text from public.receipts where workspace_id = $1 and id = $2`,
        [workspace, body.id],
      );
      expect(receiptRes.rows.length).toBe(1);
      const receiptRow = receiptRes.rows[0];
      expect(receiptRow.status).toBe('uploaded');
      expect(receiptRow.transaction_id).toBeNull();
      expect(receiptRow.job_id).not.toBeNull();

      const jobId = receiptRow.job_id!;

      // Assert public.jobs row
      const jobRes = await admin.query<{
        id: string;
        workspace_id: string;
        type: string;
        status: string;
        created_by: string;
      }>(
        `select id::text, workspace_id::text, type, status, created_by::text from public.jobs where id = $1`,
        [jobId],
      );
      expect(jobRes.rows.length).toBe(1);
      const jobRow = jobRes.rows[0];
      expect(jobRow.workspace_id).toBe(workspace);
      expect(jobRow.type).toBe('receipt_ocr');
      expect(jobRow.status).toBe('queued');
      expect(jobRow.created_by).toBe(subject);

      // Assert pgmq message exists in pgmq.q_savia_jobs
      const pgmqRes = await admin.query<{
        msg_id: string;
        message: { job_id: string; workspace_id: string; actor_id: string };
      }>(
        `select msg_id::text, message from pgmq.q_savia_jobs where message->>'job_id' = $1`,
        [jobId],
      );
      expect(pgmqRes.rows.length).toBe(1);
      const pgmqRow = pgmqRes.rows[0];
      expect(pgmqRow.message.job_id).toBe(jobId);
      expect(pgmqRow.message.workspace_id).toBe(workspace);
      expect(pgmqRow.message.actor_id).toBe(subject);
    },
  );

  it('preserves PDF upload (%PDF-): stores file, sets status = uploaded and job_id = null (no job enqueued)', async () => {
    const response = await upload(
      randomUUID(),
      { processingPreference: 'savia' },
      PDF_BYTES,
      'invoice.pdf',
      'application/pdf',
    );
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload);

    assertClosedReceiptSchema(body);
    expect(body.status).toBe('uploaded');
    expect(body.processingLocation).toBe('savia');

    // In DB public.receipts: job_id is null
    const receiptRes = await admin.query<{
      id: string;
      job_id: string | null;
      status: string;
    }>(
      `select id::text, job_id::text, status from public.receipts where workspace_id = $1 and id = $2`,
      [workspace, body.id],
    );
    expect(receiptRes.rows.length).toBe(1);
    expect(receiptRes.rows[0].job_id).toBeNull();
    expect(receiptRes.rows[0].status).toBe('uploaded');

    // No job enqueued
    const jobsRes = await admin.query(
      `select count(*) from public.jobs where workspace_id = $1`,
      [workspace],
    );
    expect(Number(jobsRes.rows[0].count)).toBe(0);

    // No pgmq message
    const pgmqRes = await admin.query(
      `select count(*) from pgmq.q_savia_jobs where message->>'workspace_id' = $1`,
      [workspace],
    );
    expect(Number(pgmqRes.rows[0].count)).toBe(0);

    // File stored in artifact storage
    const expectedPath = `workspaces/${workspace}/receipts/${body.id}/invoice.pdf`;
    expect(storage.paths).toContain(expectedPath);

    // PDF receipt is immediately confirmable via confirmReceipt
    const confirmResponse = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${body.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
      },
      payload: {
        transaction: {
          type: 'expense',
          accountId: account,
          amount: { amountMinor: '4500', currency: 'USD' },
          occurredAt: '2026-09-17T12:00:00Z',
          status: 'confirmed',
        },
      },
    });
    expect(confirmResponse.statusCode).toBe(201);
    const confirmBody = JSON.parse(confirmResponse.payload);
    expect(confirmBody.receiptId).toBe(body.id);
  });

  it('preserves spoofed MIME / arbitrary non-image non-PDF upload: stored with status = uploaded and job_id = null (no job enqueued)', async () => {
    // Client sends arbitrary ASCII/binary with image/jpeg Content-Type
    const response = await upload(
      randomUUID(),
      { processingPreference: 'savia' },
      SPOOFED_MIME_BYTES,
      'spoofed.jpg',
      'image/jpeg',
    );
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload);

    assertClosedReceiptSchema(body);
    expect(body.status).toBe('uploaded');
    expect(body.processingLocation).toBe('savia');

    // In DB public.receipts: job_id is null
    const receiptRes = await admin.query<{
      id: string;
      job_id: string | null;
      status: string;
    }>(
      `select id::text, job_id::text, status from public.receipts where workspace_id = $1 and id = $2`,
      [workspace, body.id],
    );
    expect(receiptRes.rows.length).toBe(1);
    expect(receiptRes.rows[0].job_id).toBeNull();
    expect(receiptRes.rows[0].status).toBe('uploaded');

    // No job enqueued
    const jobsRes = await admin.query(
      `select count(*) from public.jobs where workspace_id = $1`,
      [workspace],
    );
    expect(Number(jobsRes.rows[0].count)).toBe(0);

    // No pgmq message
    const pgmqRes = await admin.query(
      `select count(*) from pgmq.q_savia_jobs where message->>'workspace_id' = $1`,
      [workspace],
    );
    expect(Number(pgmqRes.rows[0].count)).toBe(0);
  });

  it('preserves device_result upload: immediately status = awaiting_review and job_id = null (no job enqueued)', async () => {
    const response = await upload(
      randomUUID(),
      {
        processingPreference: 'device_result',
        deviceOcrResult: JSON.stringify({
          merchant: { value: 'Local Cafe', confidence: 0.95 },
          total: { value: 1250, confidence: 0.9 },
        }),
      },
      JPEG_BYTES,
      'device_receipt.jpg',
      'image/jpeg',
    );
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload);

    assertClosedReceiptSchema(body);
    expect(body.status).toBe('awaiting_review');
    expect(body.processingLocation).toBe('device');

    // In DB public.receipts: job_id is null
    const receiptRes = await admin.query<{
      id: string;
      job_id: string | null;
      status: string;
    }>(
      `select id::text, job_id::text, status from public.receipts where workspace_id = $1 and id = $2`,
      [workspace, body.id],
    );
    expect(receiptRes.rows.length).toBe(1);
    expect(receiptRes.rows[0].job_id).toBeNull();
    expect(receiptRes.rows[0].status).toBe('awaiting_review');

    // No job enqueued
    const jobsRes = await admin.query(
      `select count(*) from public.jobs where workspace_id = $1`,
      [workspace],
    );
    expect(Number(jobsRes.rows[0].count)).toBe(0);
  });

  it('atomically rolls back receipt, job, and pgmq message, and compensates storage on transaction failure after upload', async () => {
    const writeSpy = vi
      .spyOn(PostgresIdempotencyAdapter.prototype, 'write')
      .mockRejectedValueOnce(
        new Error('Injected failure during idempotency write'),
      );

    const res = await upload(
      randomUUID(),
      { processingPreference: 'savia' },
      JPEG_BYTES,
      'rollback_receipt.jpg',
      'image/jpeg',
    );
    expect(res.statusCode).toBe(500);
    expect(writeSpy).toHaveBeenCalled();

    // 1. Storage compensation: storage.remove was invoked and file is absent from storage
    expect(storage.removeCalls.length).toBeGreaterThan(0);
    expect(storage.paths.length).toBe(0);

    // 2. Database atomicity: receipt row is absent
    const receiptsRes = await admin.query(
      `select count(*) from public.receipts where workspace_id = $1`,
      [workspace],
    );
    expect(Number(receiptsRes.rows[0].count)).toBe(0);

    // 3. Database atomicity: job row is absent
    const jobsRes = await admin.query(
      `select count(*) from public.jobs where workspace_id = $1`,
      [workspace],
    );
    expect(Number(jobsRes.rows[0].count)).toBe(0);

    // 4. Database atomicity: pgmq message is absent
    const pgmqRes = await admin.query(
      `select count(*) from pgmq.q_savia_jobs where message->>'workspace_id' = $1`,
      [workspace],
    );
    expect(Number(pgmqRes.rows[0].count)).toBe(0);

    writeSpy.mockRestore();
  });
});
