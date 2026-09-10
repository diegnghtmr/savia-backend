// Migrations under test: 202608310003_export_jobs.sql, 202608310004_export_storage.sql, 202609060012_export_completion_rls.sql
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

class TestStorage implements ArtifactStorage {
  public failSigning = false;

  public async upload(
    _path: string,
    _content: Buffer,
    _contentType: string,
  ): Promise<void> {}

  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    if (this.failSigning) throw new Error('signing failed');
    return { url: `https://storage.example.test/${path}`, expiresAt };
  }

  public async remove(_path: string): Promise<void> {}
}

describe('export completion over Fastify HTTP and disposable PostgreSQL', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  let storage: TestStorage;
  const subject = '11111111-0000-4000-8000-000000000071';
  const workspace = '22222222-0000-4000-8000-000000000072';

  const headers = (key: string) => ({
    authorization: 'Bearer owner',
    'x-workspace-id': workspace,
    'idempotency-key': key,
  });

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
      SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    admin = new Pool({ connectionString: url });
    storage = new TestStorage();
    await admin.query(
      "insert into auth.users (id,email) values ($1,'export-completion@test')",
      [subject],
    );
    await admin.query(
      "insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,'export-completion@test','Export Completion','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD')",
      [subject],
    );
    await admin.query(
      "insert into public.workspaces (id,name,kind,base_currency,created_by) values ($1,'Export completion','shared','USD',$2)",
      [workspace, subject],
    );
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active')",
      [workspace, subject],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner') return { subject };
          throw new Error('rejected');
        },
      })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    storage.failSigning = false;
    await admin.query('delete from public.export_jobs where workspace_id=$1', [
      workspace,
    ]);
    await admin.query(
      'delete from public.command_idempotency_records where workspace_id=$1',
      [workspace],
    );
  });

  afterAll(async () => {
    await app?.close();
    await admin?.query('delete from public.workspaces where id=$1', [workspace]);
    await admin?.query('delete from auth.users where id=$1', [subject]);
    await admin?.end();
  });

  it('completes a real export and persists its download URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/export-jobs',
      headers: headers('33333333-0000-4000-8000-000000000073'),
      payload: { format: 'json_backup', resource: 'transactions' },
    });
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload) as {
      id: string;
      status: string;
      downloadUrl: string;
    };
    expect(body.status).toBe('completed');
    expect(body.downloadUrl).toContain('https://storage.example.test/');
    const row = await admin.query<{ status: string }>(
      'select status from public.export_jobs where id=$1',
      [body.id],
    );
    expect(row.rows[0]?.status).toBe('completed');
  });

  it('marks the reserved export failed when signing fails', async () => {
    storage.failSigning = true;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/export-jobs',
      headers: headers('44444444-0000-4000-8000-000000000074'),
      payload: { format: 'json_backup', resource: 'transactions' },
    });
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.payload) as { id: string; status: string };
    expect(body.status).toBe('failed');
    const row = await admin.query<{ status: string }>(
      'select status from public.export_jobs where id=$1',
      [body.id],
    );
    expect(row.rows[0]?.status).toBe('failed');
  });
});
