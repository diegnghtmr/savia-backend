// Migration under test: 202609170003_receipt_ocr.sql
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import {
  ARTIFACT_STORAGE,
  ArtifactStorageUnavailableError,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import { OCR_ENGINE } from '../../src/platform/ocr-engine.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import {
  assertOcrCapabilityForCi,
  probeOcrCapabilities,
} from '../../src/platform/tesseract-capability-probe.js';
import { PostgresReceiptAdapter } from '../../src/receipts/postgres-receipt.adapter.js';
import * as tesseractAdapter from '../../src/platform/system-tesseract.adapter.js';
import { WorkerModule } from '../../src/worker.module.js';
import { FakeOcrEngine } from '../support/fake-ocr-engine.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const SIMPLE_PNG = readFileSync(
  path.join(__dirname, '../fixtures/receipt-simple.png'),
);
const SPANISH_PNG = readFileSync(
  path.join(__dirname, '../fixtures/receipt-spanish.png'),
);

const MERCHANT_SENTINEL = 'MERCHANT_SENTINEL_NORTE';
const TOTAL_SENTINEL = 77123;
const FILE_NAME = 'norte-ticket.png';

class MemoryStorage implements ArtifactStorage {
  public readonly objects = new Map<string, Buffer>();

  public async upload(pathName: string, content: Buffer): Promise<void> {
    this.objects.set(pathName, content);
  }

  public async sign(
    pathName: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    return { url: pathName, expiresAt };
  }

  public async download(pathName: string): Promise<Buffer> {
    const content = this.objects.get(pathName);
    if (!content) {
      throw new Error(`Artifact not found at path: ${pathName}`);
    }
    return content;
  }

  public async remove(pathName: string): Promise<void> {
    this.objects.delete(pathName);
  }
}

const boundary = 'savia-receipt-ocr-boundary';
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

function bombPng(): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(50_000, 16);
  buf.writeUInt32BE(50_000, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0x12345678, 29);
  return buf;
}

const CORRUPT_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const PDF_BYTES = Buffer.from('%PDF-1.7 mock receipt content');
const TEXT_BYTES = Buffer.from('Plain text claiming to be an image');

const ACCENTED_TOKEN = /JARDÍN|CAFÉ|TÍPICO/;

function recognizeWithLang(image: Buffer, lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/tesseract',
      ['stdin', 'stdout', '-l', lang, '--psm', '3', '--oem', '1', 'tsv'],
      {
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tesseract -l ${lang} exit ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(image);
  });
}

describe('Receipt OCR end-to-end against a disposable database', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  let workerModule: TestingModule;
  let runner: JobRunner;
  let storage: MemoryStorage;
  let fakeEngine: FakeOcrEngine;
  const capturedLogs: string[] = [];
  const ownerA = '00000000-0000-4000-8000-000000009971';
  const ownerB = '00000000-0000-4000-8000-000000009972';
  let workspace: string;
  let account: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    const capture = (...args: unknown[]): void => {
      capturedLogs.push(args.map(String).join(' '));
    };
    vi.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'verbose').mockImplementation(capture);

    vi.spyOn(tesseractAdapter, 'runOcrStartupPreflight').mockResolvedValue(
      undefined,
    );

    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id, email) values
         ($1, 'ocr-e2e-owner-a@test'),
         ($2, 'ocr-e2e-owner-b@test')
       on conflict (id) do nothing`,
      [ownerA, ownerB],
    );
    await admin.query(
      `insert into public.profiles (
         id, email, display_name, locale, country_code, timezone,
         date_format, week_starts_on, number_format, default_currency
       ) values
         ($1, 'ocr-e2e-owner-a@test', 'OCR E2E Owner A', 'en', 'US', 'UTC',
          'YYYY-MM-DD', 1, '1,234.56', 'USD'),
         ($2, 'ocr-e2e-owner-b@test', 'OCR E2E Owner B', 'en', 'US', 'UTC',
          'YYYY-MM-DD', 1, '1,234.56', 'USD')
       on conflict (id) do nothing`,
      [ownerA, ownerB],
    );

    storage = new MemoryStorage();
    fakeEngine = new FakeOcrEngine();
    fakeEngine.result = {
      lines: [
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 1,
          text: MERCHANT_SENTINEL,
          confidence: 0.95,
          tokens: [],
        },
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 2,
          text: 'FECHA: 2026-09-15',
          confidence: 0.9,
          tokens: [],
        },
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 3,
          text: `TOTAL: COP ${TOTAL_SENTINEL}.00`,
          confidence: 0.94,
          tokens: [],
        },
      ],
      tokens: [],
      rawTsv: '',
    };

    const appRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner') return { subject: ownerA };
          if (token === 'owner-b') return { subject: ownerB };
          throw new Error('rejected');
        },
      })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(storage)
      .compile();

    app = appRef.createNestApplication<NestFastifyApplication>(
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

    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(storage)
      .overrideProvider(OCR_ENGINE)
      .useValue(fakeEngine)
      .compile();
    await workerModule.init();
    runner = workerModule.get(JobRunner);
  });

  beforeEach(async () => {
    fakeEngine.reset();
    fakeEngine.result = {
      lines: [
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 1,
          text: MERCHANT_SENTINEL,
          confidence: 0.95,
          tokens: [],
        },
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 2,
          text: 'FECHA: 2026-09-15',
          confidence: 0.9,
          tokens: [],
        },
        {
          pageNum: 1,
          blockNum: 1,
          parNum: 1,
          lineNum: 3,
          text: `TOTAL: COP ${TOTAL_SENTINEL}.00`,
          confidence: 0.94,
          tokens: [],
        },
      ],
      tokens: [],
      rawTsv: '',
    };
    capturedLogs.length = 0;
    storage.objects.clear();
    workspace = randomUUID();
    account = randomUUID();
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency) values ($1, 'OCR E2E Workspace', 'shared', 'USD')`,
      [workspace],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
      [workspace, ownerA],
    );
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by) values ($1, $2, 'Checking Account', 'checking', 'USD', 'active', $3)`,
      [account, workspace, ownerA],
    );
  });

  afterEach(async () => {
    await admin.query('delete from public.workspaces where id = $1', [
      workspace,
    ]);
    await admin.query('delete from pgmq.q_savia_jobs');
  });

  afterAll(async () => {
    await workerModule?.close();
    await app?.close();
    await admin.query('delete from auth.users where id in ($1, $2)', [
      ownerA,
      ownerB,
    ]);
    await admin.end();
    vi.restoreAllMocks();
  });

  async function upload(
    bytes: Buffer,
    name = FILE_NAME,
    contentType = 'image/png',
    token = 'owner',
    workspaceId = workspace,
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/receipts',
      headers: {
        authorization: `Bearer ${token}`,
        'x-workspace-id': workspaceId,
        'idempotency-key': randomUUID(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: form(bytes, name, contentType, {
        processingPreference: 'savia',
      }),
    });
  }

  async function getReceipt(
    id: string,
    token = 'owner',
    workspaceId = workspace,
  ) {
    return app.inject({
      method: 'GET',
      url: `/v1/receipts/${id}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-workspace-id': workspaceId,
      },
    });
  }

  async function confirmReceipt(id: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/receipts/${id}/confirm`,
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
  }

  async function receiptRow(id: string): Promise<{
    status: string;
    job_id: string | null;
    error: unknown;
    transaction_id: string | null;
    merchant: { value: unknown } | null;
  }> {
    const result = await admin.query<{
      status: string;
      job_id: string | null;
      error: unknown;
      transaction_id: string | null;
      merchant: { value: unknown } | null;
    }>(
      `select status, job_id::text, error, transaction_id::text, merchant
         from public.receipts where id = $1`,
      [id],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  }

  it('happy path: savia PNG upload drains to awaiting_review with extracted fields', async () => {
    const response = await upload(SIMPLE_PNG);
    expect(response.statusCode).toBe(202);
    const created = JSON.parse(response.payload) as Record<string, unknown>;
    assertClosedReceiptSchema(created);
    expect(created.status).toBe('uploaded');
    const uploadedGet = await getReceipt(String(created.id));
    expect(uploadedGet.statusCode).toBe(200);
    assertClosedReceiptSchema(JSON.parse(uploadedGet.payload));

    const row = await receiptRow(String(created.id));
    expect(row.job_id).not.toBeNull();
    expect(row.status).toBe('uploaded');

    const drained = await runner.drainOnce();
    expect(drained).toBe(1);

    const after = await getReceipt(String(created.id));
    expect(after.statusCode).toBe(200);
    const body = JSON.parse(after.payload) as {
      status: string;
      merchant: { value: string } | null;
      total: { value: number } | null;
    };
    assertClosedReceiptSchema(body);
    expect(body.status).toBe('awaiting_review');
    expect(body.merchant?.value).toBe(MERCHANT_SENTINEL);
    expect(body.total?.value).toBe(TOTAL_SENTINEL);
  });

  it('confirmation flow: confirm after OCR creates a transaction and sets confirmed', async () => {
    const created = JSON.parse((await upload(SIMPLE_PNG)).payload) as {
      id: string;
    };
    await runner.drainOnce();
    const confirm = await confirmReceipt(created.id);
    expect(confirm.statusCode).toBe(201);
    const confirmBody = JSON.parse(confirm.payload) as { receiptId: string };
    expect(confirmBody.receiptId).toBe(created.id);
    const got = await getReceipt(created.id);
    expect(got.statusCode).toBe(200);
    const body = JSON.parse(got.payload) as {
      status: string;
      transactionId: string | null;
    };
    assertClosedReceiptSchema(body);
    expect(body.status).toBe('confirmed');
    expect(body.transactionId).not.toBeNull();
  });

  it('concurrent confirmation race: user transaction is preserved and OCR does not overwrite it', async () => {
    const created = JSON.parse((await upload(SIMPLE_PNG)).payload) as {
      id: string;
    };
    const confirm = await confirmReceipt(created.id);
    expect(confirm.statusCode).toBe(201);
    const before = await receiptRow(created.id);
    expect(before.status).toBe('confirmed');
    expect(before.transaction_id).not.toBeNull();
    const transactionId = before.transaction_id;

    await runner.drainOnce();

    const after = await receiptRow(created.id);
    expect(after.status).toBe('confirmed');
    expect(after.transaction_id).toBe(transactionId);
    expect(after.merchant).toBeNull();
    const job = await admin.query<{ status: string }>(
      `select status from public.jobs where id = $1`,
      [before.job_id],
    );
    expect(job.rows[0]?.status).toBe('completed');
  });

  it('corrupt image becomes a permanent failure projected onto the receipt', async () => {
    const created = JSON.parse(
      (await upload(CORRUPT_JPEG, 'broken.jpg', 'image/jpeg')).payload,
    ) as {
      id: string;
    };
    await runner.drainOnce();
    const row = await receiptRow(created.id);
    expect(row.status).toBe('failed');
    expect(row.error).not.toBeNull();
    expect((row.error as { code: string }).code).toBe('receipt_corrupt_image');
    const got = await getReceipt(created.id);
    expect(got.statusCode).toBe(200);
    const body = JSON.parse(got.payload) as Record<string, unknown>;
    assertClosedReceiptSchema(body);
    expect(body.status).toBe('failed');
  });

  it('decompression bomb is a permanent failure projected onto the receipt', async () => {
    const created = JSON.parse((await upload(bombPng())).payload) as {
      id: string;
    };
    await runner.drainOnce();
    const row = await receiptRow(created.id);
    expect(row.status).toBe('failed');
    expect(row.error).not.toBeNull();
    expect((row.error as { code: string }).code).toBe(
      'receipt_dimensions_exceeded',
    );
  });

  it('confirming a failed receipt succeeds manually', async () => {
    const created = JSON.parse(
      (await upload(CORRUPT_JPEG, 'broken.jpg', 'image/jpeg')).payload,
    ) as {
      id: string;
    };
    await runner.drainOnce();
    expect((await receiptRow(created.id)).status).toBe('failed');
    const confirm = await confirmReceipt(created.id);
    expect(confirm.statusCode).toBe(201);
    const got = await getReceipt(created.id);
    const body = JSON.parse(got.payload) as { status: string };
    assertClosedReceiptSchema(body);
    expect(body.status).toBe('confirmed');
  });

  it('PDF upload stays uploaded with null job_id and confirm succeeds immediately', async () => {
    const response = await upload(PDF_BYTES, 'invoice.pdf', 'application/pdf');
    expect(response.statusCode).toBe(202);
    const created = JSON.parse(response.payload) as { id: string };
    const row = await receiptRow(created.id);
    expect(row.status).toBe('uploaded');
    expect(row.job_id).toBeNull();
    const jobs = await admin.query(
      `select count(*)::int as n from public.jobs where workspace_id = $1`,
      [workspace],
    );
    expect(jobs.rows[0].n).toBe(0);
    const confirm = await confirmReceipt(created.id);
    expect(confirm.statusCode).toBe(201);
  });

  it('non-image upload stays uploaded with null job_id and no job', async () => {
    const response = await upload(TEXT_BYTES, 'spoofed.jpg', 'image/jpeg');
    expect(response.statusCode).toBe(202);
    const created = JSON.parse(response.payload) as { id: string };
    const row = await receiptRow(created.id);
    expect(row.status).toBe('uploaded');
    expect(row.job_id).toBeNull();
    const jobs = await admin.query(
      `select count(*)::int as n from public.jobs where workspace_id = $1`,
      [workspace],
    );
    expect(jobs.rows[0].n).toBe(0);
  });

  it('dead-letter after 5 transient failures projects receipts.status failed', async () => {
    fakeEngine.error = new ArtifactStorageUnavailableError(
      'Storage download failed.',
    );
    const created = JSON.parse((await upload(SIMPLE_PNG)).payload) as {
      id: string;
    };
    const row = await receiptRow(created.id);
    expect(row.job_id).not.toBeNull();
    const jobId = row.job_id!;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await runner.drainOnce()).toBe(1);
      await admin.query(
        `update pgmq.q_savia_jobs set vt = now() - interval '1 second' where (message->>'job_id')::uuid = $1::uuid`,
        [jobId],
      );
    }
    expect(await runner.drainOnce()).toBe(1);

    const job = await admin.query<{ status: string }>(
      `select status from public.jobs where id = $1`,
      [jobId],
    );
    expect(job.rows[0]?.status).toBe('dead_letter');
    const failed = await receiptRow(created.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).not.toBeNull();
  });

  it('workspace RLS isolation: worker in A cannot read or mutate B', async () => {
    const workspaceB = randomUUID();
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency) values ($1, 'OCR E2E Workspace B', 'shared', 'USD')`,
      [workspaceB],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'), ($3, $4, 'editor', 'active')`,
      [workspaceB, ownerB, workspaceB, ownerA],
    );
    try {
      const uploadedB = JSON.parse(
        (
          await upload(
            SIMPLE_PNG,
            FILE_NAME,
            'image/png',
            'owner-b',
            workspaceB,
          )
        ).payload,
      ) as { id: string };
      const rowB = await receiptRow(uploadedB.id);
      expect(rowB.job_id).not.toBeNull();

      const store = new PostgresReceiptAdapter();
      const tx = workerModule.get(PgTransaction);
      const binding = await tx.runRead(ownerA, async (client) =>
        store.findOcrBinding(client, workspace, uploadedB.id, rowB.job_id!),
      );
      expect(binding).toBeNull();

      const mutated = await tx.run(ownerA, async (client) =>
        store.updateOcrResultCas(
          client,
          workspace,
          uploadedB.id,
          rowB.job_id!,
          {
            merchant: { value: 'LEAKED', confidence: 1 },
            date: null,
            currency: null,
            total: null,
          },
        ),
      );
      expect(mutated).toBe(false);
      expect((await receiptRow(uploadedB.id)).merchant).toBeNull();
    } finally {
      await admin.query('delete from public.workspaces where id = $1', [
        workspaceB,
      ]);
    }
  });

  it('creator RLS: a demoted creator cannot read the OCR binding', async () => {
    const created = JSON.parse((await upload(SIMPLE_PNG)).payload) as {
      id: string;
    };
    const row = await receiptRow(created.id);
    expect(row.job_id).not.toBeNull();
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [workspace, ownerB],
    );
    await admin.query(
      `update public.workspace_memberships
          set status = 'suspended'
        where workspace_id = $1 and profile_id = $2`,
      [workspace, ownerA],
    );
    const store = new PostgresReceiptAdapter();
    const tx = workerModule.get(PgTransaction);
    const binding = await tx.runRead(ownerA, async (client) =>
      store.findOcrBinding(client, workspace, created.id, row.job_id!),
    );
    expect(binding).toBeNull();
  });

  it('telemetry omits file names, storage paths, OCR text, and financial amounts', async () => {
    expect((await upload(SIMPLE_PNG)).statusCode).toBe(202);
    capturedLogs.length = 0;
    await runner.drainOnce();
    const joined = capturedLogs.join('\n');
    expect(joined).not.toContain(FILE_NAME);
    expect(joined).not.toContain(`workspaces/${workspace}/receipts/`);
    expect(joined).not.toContain(MERCHANT_SENTINEL);
    expect(joined).not.toContain(String(TOTAL_SENTINEL));
    expect(joined).toMatch(/receipt_ocr_/);
  });

  it('proves English-only Tesseract does not keep accented Spanish tokens; spa case runs in CI', async () => {
    const englishTsv = await recognizeWithLang(SPANISH_PNG, 'eng');
    expect(
      ACCENTED_TOKEN.test(englishTsv),
      `English-only Tesseract must not produce JARDÍN/CAFÉ/TÍPICO. Output was:\n${englishTsv}`,
    ).toBe(false);

    const probe = await probeOcrCapabilities();
    if (!probe.supported) {
      assertOcrCapabilityForCi(probe);
      console.warn(
        `\n[receipt-ocr e2e] SKIPPED spa accented-token case: ${probe.skipReason}\n(Host does not have tesseract-ocr-spa; CI installs distro packages and must fail this case if the accented token is missing.)\n`,
      );
      return;
    }

    const spaTsv = await recognizeWithLang(SPANISH_PNG, 'eng+spa');
    expect(
      ACCENTED_TOKEN.test(spaTsv),
      `eng+spa must keep an accented token English-only lacks. Output was:\n${spaTsv}`,
    ).toBe(true);
  });
});
