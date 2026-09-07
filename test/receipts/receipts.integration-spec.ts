// Migration under test: 202609060004_receipts.sql
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
} from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
process.env.JWT_ISSUER = 'https://issuer.example.test';
process.env.JWT_AUDIENCE = 'savia-api';
process.env.JWT_JWKS_URI = 'https://issuer.example.test/jwks';
process.env.JWT_ALGORITHMS = 'RS256';

class MemoryStorage implements ArtifactStorage {
  public readonly paths: string[] = [];
  public async upload(path: string): Promise<void> {
    this.paths.push(path);
  }
  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    return { url: path, expiresAt };
  }
  public async remove(path: string): Promise<void> {
    this.paths.splice(this.paths.indexOf(path), 1);
  }
}

const boundary = 'savia-receipts-boundary';
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
  for (const [key, value] of Object.entries(fields))
    chunks.push(
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}`,
      ),
    );
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe('receipts over Fastify multipart HTTP', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  const subject = '00000000-0000-4000-8000-000000009901';
  const viewer = '00000000-0000-4000-8000-000000009902';
  let workspace: string;
  let account: string;
  let foreignWorkspace: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id,email) values ($1,'receipt-owner@test'),($2,'receipt-viewer@test') on conflict (id) do nothing`,
      [subject, viewer],
    );
    await admin.query(
      `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,'receipt-owner@test','Receipt Owner','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($2,'receipt-viewer@test','Receipt Viewer','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD') on conflict (id) do nothing`,
      [subject, viewer],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) =>
          token === 'owner'
            ? { subject }
            : token === 'viewer'
              ? { subject: viewer }
              : Promise.reject(new Error('rejected')),
      })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(new MemoryStorage())
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
    workspace = randomUUID();
    foreignWorkspace = randomUUID();
    account = randomUUID();
    await admin.query(
      `insert into public.workspaces (id,name,kind,base_currency) values ($1,'Receipt workspace','shared','USD'),($2,'Foreign receipt workspace','shared','USD')`,
      [workspace, foreignWorkspace],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($1,$4,'viewer','active'),($2,$3,'owner','active')`,
      [workspace, foreignWorkspace, subject, viewer],
    );
    await admin.query(
      `insert into public.accounts (id,workspace_id,name,type,currency,status,created_by) values ($1,$2,'Receipt account','checking','USD','active',$3)`,
      [account, workspace, subject],
    );
  });

  afterEach(async () => {
    await admin.query('delete from public.workspaces where id in ($1,$2)', [
      workspace,
      foreignWorkspace,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await admin.query('delete from auth.users where id in ($1,$2)', [
      subject,
      viewer,
    ]);
    await admin.end();
  });

  async function upload(
    key = randomUUID(),
    fields: Readonly<Record<string, string>> = {},
    content = Buffer.from('receipt'),
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
      payload: form(content, 'receipt.pdf', 'application/pdf', fields),
    });
  }
  function transaction(currency = 'USD') {
    return {
      type: 'expense',
      accountId: account,
      amount: { amountMinor: '100', currency },
      occurredAt: '2026-01-01T00:00:00Z',
      status: 'confirmed',
    };
  }

  it.each([
    ['savia', 'savia', 'uploaded', {}],
    [
      'external_provider',
      'external_provider',
      'uploaded',
      { processingPreference: 'external_provider' },
    ],
    [
      'device_result',
      'device',
      'awaiting_review',
      {
        processingPreference: 'device_result',
        deviceOcrResult: JSON.stringify({
          merchant: { value: 'Cafe', confidence: 1 },
        }),
      },
    ],
  ])('maps %s to %s/%s', async (_preference, location, status, fields) => {
    const response = await upload(randomUUID(), fields);
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.payload)).toMatchObject({
      processingLocation: location,
      status,
    });
  });
  it('rejects missing and contradictory device OCR', async () => {
    expect(
      (await upload(randomUUID(), { processingPreference: 'device_result' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await upload(randomUUID(), {
          deviceOcrResult: JSON.stringify({
            total: { value: 1, confidence: 1 },
          }),
        })
      ).statusCode,
    ).toBe(422);
  });
  it('rejects invalid confidence and unknown OCR fields', async () => {
    expect(
      (
        await upload(randomUUID(), {
          processingPreference: 'device_result',
          deviceOcrResult: JSON.stringify({
            total: { value: 1, confidence: 2 },
          }),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await upload(randomUUID(), {
          processingPreference: 'device_result',
          deviceOcrResult: JSON.stringify({
            unknown: { value: 1, confidence: 1 },
          }),
        })
      ).statusCode,
    ).toBe(422);
  });
  it('rejects oversized and disallowed uploads', async () => {
    expect(
      (await upload(randomUUID(), {}, Buffer.alloc(5 * 1024 * 1024 + 1)))
        .statusCode,
    ).toBe(422);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/receipts',
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: form(Buffer.from('x'), 'receipt.txt', 'text/plain'),
    });
    expect(response.statusCode).toBe(422);
  });
  it('returns 404 across workspaces for read and confirm', async () => {
    const created = JSON.parse((await upload()).payload);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/receipts/${created.id}`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': foreignWorkspace,
      },
    });
    expect(read.statusCode).toBe(404);
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${created.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': foreignWorkspace,
        'idempotency-key': randomUUID(),
      },
      payload: { transaction: transaction() },
    });
    expect(confirm.statusCode).toBe(404);
  });
  it('confirms through the ledger path and rejects a second confirmation', async () => {
    const created = JSON.parse((await upload()).payload);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${created.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
      },
      payload: { transaction: transaction() },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.payload).receiptId).toBe(created.id);
    const second = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${created.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
      },
      payload: { transaction: transaction('USD') },
    });
    expect(second.statusCode).toBe(409);
  });
  it('rejects idempotency conflict and account currency mismatch', async () => {
    const key = randomUUID();
    expect((await upload(key)).statusCode).toBe(202);
    expect((await upload(key, {}, Buffer.from('different'))).statusCode).toBe(
      409,
    );
    const created = JSON.parse((await upload()).payload);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${created.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
      },
      payload: { transaction: transaction('EUR') },
    });
    expect(response.statusCode).toBe(422);
  });
  it('enforces role gating and authentication', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/receipts',
          headers: {
            authorization: 'Bearer viewer',
            'x-workspace-id': workspace,
            'idempotency-key': randomUUID(),
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          payload: form(Buffer.from('x'), 'receipt.pdf', 'application/pdf'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/receipts/${randomUUID()}` }))
        .statusCode,
    ).toBe(401);
  });
  it('prevents financial duplication on concurrent confirms with different idempotency keys', async () => {
    const created = JSON.parse((await upload()).payload);
    await admin.query(`
      create or replace function public.delay_receipt_update() returns trigger as $$
      begin
        perform pg_sleep(0.05);
        return new;
      end;
      $$ language plpgsql;
      grant execute on function public.delay_receipt_update() to savia_application;
      create trigger trg_delay_receipt_update
      before update on public.receipts
      for each row execute function public.delay_receipt_update();
    `);
    try {
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/v1/receipts/${created.id}/confirm`,
          headers: {
            authorization: 'Bearer owner',
            'x-workspace-id': workspace,
            'idempotency-key': randomUUID(),
          },
          payload: { transaction: transaction('USD') },
        }),
        app.inject({
          method: 'POST',
          url: `/v1/receipts/${created.id}/confirm`,
          headers: {
            authorization: 'Bearer owner',
            'x-workspace-id': workspace,
            'idempotency-key': randomUUID(),
          },
          payload: { transaction: transaction('USD') },
        }),
      ]);
      const statuses = [res1.statusCode, res2.statusCode].sort();
      expect(statuses).toEqual([201, 409]);

      const txCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.transactions where workspace_id = $1',
        [workspace],
      );
      expect(txCount.rows[0].count).toBe('1');
    } finally {
      await admin.query(`
        drop trigger if exists trg_delay_receipt_update on public.receipts;
        drop function if exists public.delay_receipt_update();
      `);
    }
  });
  it('rolls back claim when transaction creation fails, leaving receipt confirmable', async () => {
    const created = JSON.parse((await upload()).payload);
    const failedResponse = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${created.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
      },
      payload: { transaction: transaction('EUR') },
    });
    expect(failedResponse.statusCode).toBe(422);

    const txCount = await admin.query<{ count: string }>(
      'select count(*)::text as count from public.transactions where workspace_id = $1',
      [workspace],
    );
    expect(txCount.rows[0].count).toBe('0');

    const retryResponse = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${created.id}/confirm`,
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': randomUUID(),
      },
      payload: { transaction: transaction('USD') },
    });
    expect(retryResponse.statusCode).toBe(201);
    expect(JSON.parse(retryResponse.payload).receiptId).toBe(created.id);
  });
});
