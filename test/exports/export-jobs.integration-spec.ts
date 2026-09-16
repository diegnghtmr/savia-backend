// Migrations under test: 202608310003_export_jobs.sql, 202608310004_export_storage.sql, 202609060012_export_completion_rls.sql, 202609160001_export_jobs_async.sql
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import { type JobExecutionContext } from '../../src/platform/job-handler.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { WorkerModule } from '../../src/worker.module.js';
import {
  ExportJobHandler,
  type ExportJobComputed,
} from '../../src/exports/export-job.handler.js';
import type { ExportJobPayload } from '../../src/exports/export-job-payload.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

class InMemoryArtifactStorage implements ArtifactStorage {
  public readonly uploaded = new Map<
    string,
    { content: Buffer; contentType: string }
  >();
  public uploadCallCount = 0;
  public signCallCount = 0;
  public removeCallCount = 0;
  public failSigning = false;

  public async upload(
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    this.uploadCallCount++;
    this.uploaded.set(path, { content, contentType });
  }

  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.signCallCount++;
    if (this.failSigning) {
      throw new Error('Signing failed for storage artifact.');
    }
    return { url: `https://storage.example.test/${path}`, expiresAt };
  }

  public async remove(path: string): Promise<void> {
    this.removeCallCount++;
    this.uploaded.delete(path);
  }
}

describe('Asynchronous export jobs integration contract and worker suite', () => {
  let admin: Pool;
  let application: NestFastifyApplication;
  let workerModule: TestingModule;
  let runner: JobRunner;
  let inMemoryStorage: InMemoryArtifactStorage;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  const acct1Usd = 'cccccccc-0000-4000-8000-000000000001';
  const tx1Id = 'eeeeeeee-0000-4000-8000-000000000001';
  const catExpenseId = 'dddddddd-0000-4000-8000-000000000001';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
      SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
    });

    admin = new Pool({ connectionString: url });
    inMemoryStorage = new InMemoryArtifactStorage();

    // 1. Seed auth users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'export-owner@example.test'),
        ($2, 'export-editor@example.test'),
        ($3, 'export-viewer@example.test'),
        ($4, 'export-other@example.test')`,
      [ownerId, editorId, viewerId, otherOwnerId],
    );

    for (const [userId, email, name] of [
      [ownerId, 'export-owner@example.test', 'Export Owner'],
      [editorId, 'export-editor@example.test', 'Export Editor'],
      [viewerId, 'export-viewer@example.test', 'Export Viewer'],
      [otherOwnerId, 'export-other@example.test', 'Export Other Owner'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (
          id, email, display_name, locale, country_code, timezone,
          date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled
        ) values (
          $1, $2, $3, 'en', 'US', 'UTC',
          'YYYY-MM-DD', 1, '1,234.56', 'USD', false
        )`,
        [userId, email, name],
      );
    }

    // 2. Seed workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', $2),
        ($3, 'Workspace 2', 'shared', 'USD', $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // 3. Seed workspace memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'editor', 'active'),
        ($1, $4, 'viewer', 'active'),
        ($5, $6, 'owner', 'active')`,
      [workspace1Id, ownerId, editorId, viewerId, workspace2Id, otherOwnerId],
    );

    // 4. Seed account in workspace 1
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by) values
        ($1, $2, 'Operating Account', 'checking', 'USD', $3)`,
      [acct1Usd, workspace1Id, ownerId],
    );

    // 5. Seed category in workspace 1
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by) values
        ($1, $2, 'Operations', 'expense', $3)`,
      [catExpenseId, workspace1Id, ownerId],
    );

    // 6. Seed transaction and ledger postings
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 5000, 'USD', '2026-06-15 12:00:00+00', $4, $5
      )`,
      [tx1Id, workspace1Id, acct1Usd, catExpenseId, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 5000, 'USD', 'confirmed', '2026-06-15 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -5000, 'USD', 'confirmed', '2026-06-15 12:00:00+00')`,
      [workspace1Id, tx1Id, acct1Usd],
    );

    // 7. Bootstrap Fastify API application
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: ownerId };
          if (token === 'editor-token') return { subject: editorId };
          if (token === 'viewer-token') return { subject: viewerId };
          if (token === 'other-owner-token') return { subject: otherOwnerId };
          throw new Error('token rejected');
        },
      })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(inMemoryStorage)
      .compile();

    application = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(application);
    await application.init();
    await application.getHttpAdapter().getInstance().ready();

    // 8. Bootstrap WorkerModule
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(ARTIFACT_STORAGE)
      .useValue(inMemoryStorage)
      .compile();
    await workerModule.init();
    runner = workerModule.get(JobRunner);
  });

  afterEach(async () => {
    inMemoryStorage.failSigning = false;
    await admin.query(
      `update public.workspace_memberships
          set role = 'editor'
        where workspace_id = $1::uuid
          and profile_id = $2::uuid`,
      [workspace1Id, editorId],
    );
    await admin.query(
      'delete from public.export_jobs where workspace_id = $1',
      [workspace1Id],
    );
    await admin.query('delete from public.jobs where workspace_id = $1', [
      workspace1Id,
    ]);
    await admin.query(
      'delete from public.command_idempotency_records where workspace_id = $1',
      [workspace1Id],
    );
  });

  afterAll(async () => {
    await workerModule?.close();
    await application?.close();
    await admin?.query('delete from public.workspaces where id in ($1, $2)', [
      workspace1Id,
      workspace2Id,
    ]);
    await admin?.query('delete from auth.users where id in ($1, $2, $3, $4)', [
      ownerId,
      editorId,
      viewerId,
      otherOwnerId,
    ]);
    await admin?.end();
  });

  describe('Policy recreate and grant pin', () => {
    it('verifies application_updates_workspace_export_jobs WITH CHECK admits processing', async () => {
      const policyRes = await admin.query<{ with_check: string }>(
        `select with_check
           from pg_policies
          where tablename = 'export_jobs'
            and policyname = 'application_updates_workspace_export_jobs'`,
      );
      expect(policyRes.rows).toHaveLength(1);
      const withCheck = policyRes.rows[0]?.with_check ?? '';
      expect(withCheck).toContain('processing');
    });

    it('pins savia_application column-level UPDATE privileges on export_jobs exactly without table-wide UPDATE', async () => {
      const tablePrivRes = await admin.query<{ privilege_type: string }>(
        `select privilege_type
           from information_schema.table_privileges
          where table_name = 'export_jobs'
            and grantee = 'savia_application'
            and privilege_type = 'UPDATE'`,
      );
      expect(tablePrivRes.rows).toHaveLength(0);

      const colPrivRes = await admin.query<{
        column_name: string;
        privilege_type: string;
      }>(
        `select column_name, privilege_type
           from information_schema.column_privileges
          where table_name = 'export_jobs'
            and grantee = 'savia_application'
            and privilege_type = 'UPDATE'`,
      );
      const cols = colPrivRes.rows.map((r) => r.column_name).sort();
      expect(cols).toEqual([
        'completed_at',
        'download_url',
        'error',
        'expires_at',
        'object_path',
        'status',
      ]);
    });

    it('allows worker transition from queued to processing under savia_application', async () => {
      const exportId = randomUUID();
      const jobId = randomUUID();
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1::uuid, $2::uuid, 'export_job', 'queued', $3::uuid)`,
        [jobId, workspace1Id, editorId],
      );
      await admin.query(
        `insert into public.export_jobs (id, workspace_id, format, resource, status, created_by, job_id)
         values ($1::uuid, $2::uuid, 'csv', 'all', 'queued', $3::uuid, $4::uuid)`,
        [exportId, workspace1Id, editorId, jobId],
      );

      // Now update status to 'processing' under savia_application role
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query("set local role 'savia_application'");
        await client.query("select set_config('app.subject_id', $1, true)", [
          editorId,
        ]);
        const updateRes = await client.query<{ id: string; status: string }>(
          `update public.export_jobs
              set status = 'processing'
            where workspace_id = $1::uuid
              and id = $2::uuid
              and status = 'queued'
            returning id::text, status`,
          [workspace1Id, exportId],
        );
        expect(updateRes.rows).toHaveLength(1);
        expect(updateRes.rows[0]?.status).toBe('processing');
        await client.query('commit');
      } finally {
        client.release();
      }
    });
  });

  describe('Asynchronous export workflow', () => {
    it('returns 202 queued without uploading before response, then drainOnce reaches completed', async () => {
      const idempotencyKey = randomUUID();
      inMemoryStorage.uploadCallCount = 0;

      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          format: 'csv',
          resource: 'all',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as {
        id: string;
        status: string;
        format: string;
        downloadUrl: string | null;
        expiresAt: string | null;
        createdAt: string;
      };

      expect(body.status).toBe('queued');
      expect(body.format).toBe('csv');
      expect(body.downloadUrl).toBeNull();
      expect(body.expiresAt).toBeNull();
      expect(typeof body.id).toBe('string');
      expect(typeof body.createdAt).toBe('string');

      // Crucial requirement: Nothing uploaded before the response
      expect(inMemoryStorage.uploadCallCount).toBe(0);

      // Verify row in DB is queued and linked to jobs
      const dbRow = await admin.query<{
        status: string;
        job_id: string;
        object_path: string | null;
      }>(
        'select status, job_id::text as job_id, object_path from public.export_jobs where id = $1::uuid',
        [body.id],
      );
      expect(dbRow.rows[0]?.status).toBe('queued');
      const jobId = dbRow.rows[0]?.job_id;
      expect(jobId).toBeDefined();

      const jobDbRow = await admin.query<{ type: string; status: string }>(
        'select type, status from public.jobs where id = $1::uuid',
        [jobId],
      );
      expect(jobDbRow.rows[0]?.type).toBe('export_job');
      expect(jobDbRow.rows[0]?.status).toBe('queued');

      // Now drain the worker
      const drained = await runner.drainOnce();
      expect(drained).toBeGreaterThanOrEqual(1);

      // Now storage has uploaded
      expect(inMemoryStorage.uploadCallCount).toBe(1);
      const expectedKey = `${workspace1Id}/${body.id}.csv`;
      expect(inMemoryStorage.uploaded.has(expectedKey)).toBe(true);

      // Check DB completed state
      const completedExport = await admin.query<{
        status: string;
        download_url: string | null;
        expires_at: string | null;
        completed_at: string | null;
      }>(
        'select status, download_url, expires_at, completed_at from public.export_jobs where id = $1::uuid',
        [body.id],
      );
      expect(completedExport.rows[0]?.status).toBe('completed');
      expect(completedExport.rows[0]?.download_url).toBe(
        `https://storage.example.test/${expectedKey}`,
      );
      expect(completedExport.rows[0]?.expires_at).not.toBeNull();
      expect(completedExport.rows[0]?.completed_at).not.toBeNull();

      // Check job completed state
      const completedJob = await admin.query<{
        status: string;
        result_resource_id: string;
      }>(
        'select status, result_resource_id::text as result_resource_id from public.jobs where id = $1::uuid',
        [jobId],
      );
      expect(completedJob.rows[0]?.status).toBe('completed');
      expect(completedJob.rows[0]?.result_resource_id).toBe(body.id);

      // GET /v1/export-jobs/{id} returns completed export
      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/export-jobs/${body.id}`,
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body) as {
        id: string;
        status: string;
        downloadUrl: string;
      };
      expect(getBody.status).toBe('completed');
      expect(getBody.downloadUrl).toBe(
        `https://storage.example.test/${expectedKey}`,
      );
    });

    it('processes json_backup format to completed with deterministic .json key', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          format: 'json_backup',
          resource: 'transactions',
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');

      await runner.drainOnce();

      const expectedKey = `${workspace1Id}/${body.id}.json`;
      expect(inMemoryStorage.uploaded.has(expectedKey)).toBe(true);

      const completed = await admin.query<{
        status: string;
        download_url: string;
      }>(
        'select status, download_url from public.export_jobs where id = $1::uuid',
        [body.id],
      );
      expect(completed.rows[0]?.status).toBe('completed');
      expect(completed.rows[0]?.download_url).toBe(
        `https://storage.example.test/${expectedKey}`,
      );
    });

    it('projects dead_letter as failed on the export job with the job error copied', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          format: 'csv',
          resource: 'all',
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };

      const link = await admin.query<{ job_id: string }>(
        'select job_id::text as job_id from public.export_jobs where id = $1::uuid',
        [body.id],
      );
      const jobId = link.rows[0]?.job_id;
      expect(jobId).toBeDefined();

      const problem = {
        type: 'https://savia.app/problems/job-exhausted',
        title: 'Job Retries Exhausted',
        status: 500,
        code: 'job_retries_exhausted',
        detail: 'Poison export job delivery exhausted',
        traceId: randomUUID(),
      };

      await admin.query('select public.dead_letter_job($1::uuid, $2::jsonb)', [
        jobId,
        JSON.stringify(problem),
      ]);

      const exportRow = await admin.query<{
        status: string;
        error: Record<string, unknown> | null;
      }>('select status, error from public.export_jobs where id = $1::uuid', [
        body.id,
      ]);
      const jobRow = await admin.query<{
        status: string;
        error: Record<string, unknown> | null;
      }>('select status, error from public.jobs where id = $1::uuid', [jobId]);

      expect(jobRow.rows[0]?.status).toBe('dead_letter');
      expect(exportRow.rows[0]?.status).toBe('failed');
      expect(exportRow.rows[0]?.error).toEqual(jobRow.rows[0]?.error);

      // Drain unconsumed message so subsequent tests see clean queue
      await runner.drainOnce();
    });

    it('fails with 403 problem when the creator is demoted before drain', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          format: 'csv',
          resource: 'all',
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');

      // Demote editor to viewer before drain
      await admin.query(
        `update public.workspace_memberships
            set role = 'viewer'
          where workspace_id = $1::uuid
            and profile_id = $2::uuid`,
        [workspace1Id, editorId],
      );

      try {
        await runner.drainOnce();

        const exportRow = await admin.query<{
          status: string;
          error: Record<string, unknown> | null;
        }>('select status, error from public.export_jobs where id = $1::uuid', [
          body.id,
        ]);
        expect(exportRow.rows[0]?.status).toBe('failed');
        expect(exportRow.rows[0]?.error).toEqual(
          expect.objectContaining({
            status: 403,
            code: 'forbidden',
          }),
        );
      } finally {
        await admin.query(
          `update public.workspace_memberships
              set role = 'editor'
            where workspace_id = $1::uuid
              and profile_id = $2::uuid`,
          [workspace1Id, editorId],
        );
      }
    });

    it('replays idempotent requests returning queued export without a second job or upload', async () => {
      const idempotencyKey = randomUUID();
      inMemoryStorage.uploadCallCount = 0;

      const first = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idempotencyKey,
        },
        payload: { format: 'csv', resource: 'all' },
      });
      expect(first.statusCode).toBe(202);
      const firstBody = JSON.parse(first.body) as { id: string };

      const second = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idempotencyKey,
        },
        payload: { format: 'csv', resource: 'all' },
      });
      expect(second.statusCode).toBe(202);
      const secondBody = JSON.parse(second.body) as { id: string };

      expect(secondBody.id).toBe(firstBody.id);
      expect(inMemoryStorage.uploadCallCount).toBe(0);

      const jobCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from public.export_jobs where workspace_id = $1::uuid',
        [workspace1Id],
      );
      expect(Number(jobCount.rows[0]?.count)).toBe(1);
    });

    it('synchronously rejects unsupported resources with 422', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { format: 'csv', resource: 'budgets' },
      });
      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as {
        status: number;
        title: string;
      };
      expect(body.status).toBe(422);
      expect(body.title).toBe('Export resource unavailable');
    });

    it('synchronously rejects unauthorized viewers with 403', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { format: 'csv', resource: 'all' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('commits export job completion and job completed status together in a single transaction', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/export-jobs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { format: 'csv', resource: 'all' },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };

      const link = await admin.query<{ job_id: string }>(
        'select job_id::text as job_id from public.export_jobs where id = $1::uuid',
        [body.id],
      );
      const jobId = link.rows[0]?.job_id;

      const exportHandler = workerModule.get(ExportJobHandler);
      expect(exportHandler).toBeDefined();

      const originalPersist = exportHandler.persist.bind(exportHandler);
      exportHandler.persist = async (
        ctx: JobExecutionContext<ExportJobPayload>,
        comp: ExportJobComputed,
        client: TransactionClient,
      ) => {
        await originalPersist(ctx, comp, client);
        // Inject refusal after the first write to assert split writes fail and nothing remains committed
        throw new Error('Injected refusal after export_jobs persist write');
      };

      try {
        await runner.drainOnce();

        const exportRow = await admin.query<{ status: string }>(
          'select status from public.export_jobs where id = $1::uuid',
          [body.id],
        );
        const jobRow = await admin.query<{ status: string }>(
          'select status from public.jobs where id = $1::uuid',
          [jobId],
        );

        // Neither write committed to completed status
        expect(exportRow.rows[0]?.status).not.toBe('completed');
        expect(jobRow.rows[0]?.status).not.toBe('completed');
      } finally {
        exportHandler!.persist = originalPersist;
      }
    });
  });
});
