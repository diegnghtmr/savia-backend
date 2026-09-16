// Migrations under test: 202609050001_report_definitions.sql, 202609050002_report_runs.sql, 202609150001_report_runs_async.sql, 202609150002_report_run_job_failure_projection.sql
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
import {
  JOB_HANDLERS,
  type JobHandler,
  type RenderingJobHandler,
} from '../../src/platform/job-handler.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import {
  ARTIFACT_STORAGE,
  ArtifactStorageClientError,
  ArtifactStorageUnavailableError,
  type ArtifactStorage,
} from '../../src/platform/artifact-storage.port.js';
import { WorkerModule } from '../../src/worker.module.js';
import {
  createReportRunCommand,
  ReportRunCommandValidationError,
} from '../../src/reports/report-run-command.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';
import {
  REPORT_GRID_CELL_CAP,
  REPORT_MAX_CELL_STRING_LENGTH,
  REPORT_SOURCE_ROW_CAP,
  setReportGridCellCap,
  setReportMaxCellStringLength,
  setReportSourceRowCap,
} from '../../src/reports/report.port.js';

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
  public failRemove = false;
  public failNext: Array<'unavailable' | number> = [];

  public async upload(
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    this.uploadCallCount++;
    const fail = this.failNext.shift();
    if (fail === 'unavailable') {
      throw new ArtifactStorageUnavailableError(
        'Storage upload failed with status 503.',
      );
    }
    if (typeof fail === 'number') {
      throw new ArtifactStorageClientError(
        fail,
        `Storage upload failed with status ${fail}.`,
      );
    }
    this.uploaded.set(path, { content, contentType });
  }

  public async sign(
    path: string,
    expiresAt: Date,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.signCallCount++;
    return { url: `https://storage.example.test/${path}`, expiresAt };
  }

  public async remove(path: string): Promise<void> {
    this.removeCallCount++;
    if (this.failRemove) {
      throw new Error('cleanup failed');
    }
    this.uploaded.delete(path);
  }
}

describe('Report runs integration contract and endpoint suite', () => {
  let admin: Pool;
  let application: NestFastifyApplication;
  let workerModule: TestingModule;
  let runner: JobRunner;
  let inMemoryStorage: InMemoryArtifactStorage;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';
  const nonMemberId = '55555555-0000-4000-8000-000000000001';
  const dualMemberId = '66666666-0000-4000-8000-000000000001';
  const adminId = '77777777-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  const acct1Usd = 'cccccccc-0000-4000-8000-000000000001';
  const acct1Eur = 'cccccccc-0000-4000-8000-000000000002';
  const acct2Usd = 'cccccccc-0000-4000-8000-000000000003';

  const catExpenseId = 'dddddddd-0000-4000-8000-000000000001';
  const catIncomeId = 'dddddddd-0000-4000-8000-000000000002';
  const catExpense2Id = 'dddddddd-0000-4000-8000-000000000003';
  const catNoPostingsId = 'dddddddd-0000-4000-8000-000000000004';
  const catPendingPostingId = 'dddddddd-0000-4000-8000-000000000005';

  const txEurId = 'eeeeeeee-0000-4000-8000-000000000001';
  const txEur2Id = 'eeeeeeee-0000-4000-8000-000000000002';
  const txJulyId = 'eeeeeeee-0000-4000-8000-000000000003';
  const txIncomeId = 'eeeeeeee-0000-4000-8000-000000000004';
  const txNoPostingsId = 'eeeeeeee-0000-4000-8000-000000000005';
  const txPendingPostingId = 'eeeeeeee-0000-4000-8000-000000000006';

  const budgetJuneId = 'ffffffff-0000-4000-8000-000000000001';
  const customDefId = 'aaaaaaaa-1111-4000-8000-000000000001';
  const defW2Id = 'aaaaaaaa-2222-4000-8000-000000000001';
  const defExpenseOnlyId = 'aaaaaaaa-3333-4000-8000-000000000001';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });
    inMemoryStorage = new InMemoryArtifactStorage();

    // 1. Seed auth users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'reports-owner@example.test'),
        ($2, 'reports-editor@example.test'),
        ($3, 'reports-viewer@example.test'),
        ($4, 'reports-other@example.test'),
        ($5, 'reports-nonmember@example.test'),
        ($6, 'reports-dual@example.test'),
        ($7, 'reports-admin@example.test')`,
      [
        ownerId,
        editorId,
        viewerId,
        otherOwnerId,
        nonMemberId,
        dualMemberId,
        adminId,
      ],
    );

    for (const [userId, email, name] of [
      [ownerId, 'reports-owner@example.test', 'Reports Owner'],
      [editorId, 'reports-editor@example.test', 'Reports Editor'],
      [viewerId, 'reports-viewer@example.test', 'Reports Viewer'],
      [otherOwnerId, 'reports-other@example.test', 'Reports Other Owner'],
      [nonMemberId, 'reports-nonmember@example.test', 'Reports Non Member'],
      [dualMemberId, 'reports-dual@example.test', 'Reports Dual Member'],
      [adminId, 'reports-admin@example.test', 'Reports Administrator'],
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
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Workspace 2', 'shared', 'USD', null, $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // 3. Seed memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'editor', 'active'),
        ($1, $4, 'viewer', 'active'),
        ($1, $5, 'administrator', 'active'),
        ($1, $6, 'editor', 'active'),
        ($7, $8, 'owner', 'active'),
        ($7, $6, 'editor', 'active')`,
      [
        workspace1Id,
        ownerId,
        editorId,
        viewerId,
        adminId,
        dualMemberId,
        workspace2Id,
        otherOwnerId,
      ],
    );

    // 4. Seed exchange rate: EUR -> USD = 1.10 in workspace1Id
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by) values
        ($1, 'EUR', 'USD', 1.10, now() - interval '1 day', 'manual', $2)`,
      [workspace1Id, ownerId],
    );

    // 5. Seed accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by) values
        ($1, $2, 'USD Checking', 'checking', 'USD', $3),
        ($4, $2, 'EUR Checking', 'checking', 'EUR', $3),
        ($5, $6, 'W2 USD Checking', 'checking', 'USD', $7)`,
      [
        acct1Usd,
        workspace1Id,
        ownerId,
        acct1Eur,
        acct2Usd,
        workspace2Id,
        otherOwnerId,
      ],
    );

    // 6. Seed categories
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by) values
        ($1, $2, 'Expenses', 'expense', $3),
        ($4, $2, 'Income', 'income', $3),
        ($5, $2, 'Utilities', 'expense', $3),
        ($6, $2, 'No Postings Cat', 'expense', $3),
        ($7, $2, 'Pending Postings Cat', 'expense', $3)`,
      [
        catExpenseId,
        workspace1Id,
        ownerId,
        catIncomeId,
        catExpense2Id,
        catNoPostingsId,
        catPendingPostingId,
      ],
    );

    // 7. Seed confirmed EUR transaction with confirmed ledger posting (transfer_id is null)
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 10000, 'EUR', '2026-06-15 12:00:00+00', $4, $5
      )`,
      [txEurId, workspace1Id, acct1Eur, catExpenseId, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 10000, 'EUR', 'confirmed', '2026-06-15 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -10000, 'EUR', 'confirmed', '2026-06-15 12:00:00+00')`,
      [workspace1Id, txEurId, acct1Eur],
    );

    // Seed second EUR transaction with catExpense2Id (for partial budget warning test)
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 5000, 'EUR', '2026-06-16 12:00:00+00', $4, $5
      )`,
      [txEur2Id, workspace1Id, acct1Eur, catExpense2Id, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 5000, 'EUR', 'confirmed', '2026-06-16 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -5000, 'EUR', 'confirmed', '2026-06-16 12:00:00+00')`,
      [workspace1Id, txEur2Id, acct1Eur],
    );

    // Seed July transaction in USD
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 3000, 'USD', '2026-07-15 12:00:00+00', $4, $5
      )`,
      [txJulyId, workspace1Id, acct1Usd, catExpenseId, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 3000, 'USD', 'confirmed', '2026-07-15 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -3000, 'USD', 'confirmed', '2026-07-15 12:00:00+00')`,
      [workspace1Id, txJulyId, acct1Usd],
    );

    // Seed confirmed USD income transaction
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'income', 'confirmed', 80000, 'USD', '2026-06-20 12:00:00+00', $4, $5
      )`,
      [txIncomeId, workspace1Id, acct1Usd, catIncomeId, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 80000, 'USD', 'confirmed', '2026-06-20 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -80000, 'USD', 'confirmed', '2026-06-20 12:00:00+00')`,
      [workspace1Id, txIncomeId, acct1Usd],
    );

    // Seed confirmed transaction with NO postings (isolated to positive posting predicate)
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 15000, 'USD', '2026-06-21 12:00:00+00', $4, $5
      )`,
      [txNoPostingsId, workspace1Id, acct1Usd, catNoPostingsId, ownerId],
    );

    // Seed confirmed transaction with one confirmed and one pending posting (isolated to negative posting predicate)
    await admin.query(
      `insert into public.transactions (
        id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by
      ) values (
        $1, $2, $3, 'expense', 'confirmed', 25000, 'USD', '2026-06-22 12:00:00+00', $4, $5
      )`,
      [
        txPendingPostingId,
        workspace1Id,
        acct1Usd,
        catPendingPostingId,
        ownerId,
      ],
    );
    await admin.query(
      `insert into public.ledger_postings (
        id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at
      ) values
        (gen_random_uuid(), $1, $2, $3, 'account', 25000, 'USD', 'confirmed', '2026-06-22 12:00:00+00'),
        (gen_random_uuid(), $1, $2, null, 'external', -25000, 'USD', 'pending', '2026-06-22 12:00:00+00')`,
      [workspace1Id, txPendingPostingId, acct1Usd],
    );

    // 8. Seed June budget with allocation only for catExpenseId
    await admin.query(
      `insert into public.budgets (id, workspace_id, name, method, period_start, period_end, currency, created_by) values
        ($1, $2, 'June Budget', 'envelope', '2026-06-01', '2026-06-30', 'USD', $3)`,
      [budgetJuneId, workspace1Id, ownerId],
    );
    await admin.query(
      `insert into public.budget_allocations (id, workspace_id, budget_id, category_id, planned_minor) values
        (gen_random_uuid(), $1, $2, $3, 50000)`,
      [workspace1Id, budgetJuneId, catExpenseId],
    );

    // 9. Seed custom report definition with budget measure
    await admin.query(
      `insert into public.report_definitions (id, workspace_id, name, dimensions, measures, visualization, filters, created_by) values
        ($1, $2, 'Custom Budget Def', '["month", "category"]'::jsonb, '["budget", "converted_value"]'::jsonb, 'table', '{}'::jsonb, $3)`,
      [customDefId, workspace1Id, ownerId],
    );

    // 10. Seed definition in workspace 2 (for dual member cross-workspace scoping test)
    await admin.query(
      `insert into public.report_definitions (id, workspace_id, name, dimensions, measures, visualization, filters, created_by) values
        ($1, $2, 'Workspace 2 Def', '["month"]'::jsonb, '["converted_value"]'::jsonb, 'table', '{}'::jsonb, $3)`,
      [defW2Id, workspace2Id, otherOwnerId],
    );

    // 11. Seed definition with type: 'expense' in workspace 1 (for FIX 8 definition filter test)
    await admin.query(
      `insert into public.report_definitions (id, workspace_id, name, dimensions, measures, visualization, filters, created_by) values
        ($1, $2, 'Expense Only Def', '["category"]'::jsonb, '["converted_value"]'::jsonb, 'table', '{"type": "expense"}'::jsonb, $3)`,
      [defExpenseOnlyId, workspace1Id, ownerId],
    );

    // Bootstrap Nest application
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
          if (token === 'non-member-token') return { subject: nonMemberId };
          if (token === 'dual-member-token') return { subject: dualMemberId };
          if (token === 'admin-token') return { subject: adminId };
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
    inMemoryStorage.failNext = [];
    await admin.query(
      `update public.workspace_memberships
          set role = 'editor'
        where workspace_id = $1::uuid
          and profile_id = $2::uuid`,
      [workspace1Id, editorId],
    );
  });

  afterAll(async () => {
    if (workerModule) {
      await workerModule.close();
    }
    if (application) {
      await application.close();
    }
    if (admin) {
      await admin.end();
    }
  });

  async function drainUntilRunTerminal(runId: string): Promise<{
    jobStatus: string;
    jobError: Record<string, unknown> | null;
    runStatus: string;
    runError: Record<string, unknown> | null;
    downloadUrl: string | null;
  }> {
    const link = await admin.query<{ job_id: string }>(
      `select job_id::text as job_id from public.report_runs where id = $1::uuid`,
      [runId],
    );
    const jobId = link.rows[0]?.job_id;
    if (!jobId) {
      throw new Error(`Report run ${runId} has no job_id`);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const job = await admin.query<{
        status: string;
        error: Record<string, unknown> | null;
      }>(`select status, error from public.jobs where id = $1::uuid`, [jobId]);
      const run = await admin.query<{
        status: string;
        error: Record<string, unknown> | null;
        download_url: string | null;
      }>(
        `select status, error, download_url from public.report_runs where id = $1::uuid`,
        [runId],
      );
      const jobStatus = job.rows[0]?.status;
      if (
        jobStatus &&
        ['completed', 'failed', 'dead_letter', 'cancelled'].includes(jobStatus)
      ) {
        return {
          jobStatus,
          jobError: job.rows[0]?.error ?? null,
          runStatus: run.rows[0]?.status ?? '',
          runError: run.rows[0]?.error ?? null,
          downloadUrl: run.rows[0]?.download_url ?? null,
        };
      }
      await runner.drainOnce();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Report run ${runId} did not reach a terminal job status`);
  }

  describe('Database schema and constraints', () => {
    it('has the report runs table and terminal status constraint installed', async () => {
      const result = await admin.query<{
        tableName: string;
        constraintName: string;
      }>(
        `select c.relname as "tableName", con.conname as "constraintName"
           from pg_class c join pg_constraint con on con.conrelid = c.oid
          where c.relname = 'report_runs' and con.conname = 'report_runs_status_check'`,
      );
      expect(result.rows).toEqual([
        {
          tableName: 'report_runs',
          constraintName: 'report_runs_status_check',
        },
      ]);
    });

    it('rejects a request that does not select exactly one report shape', () => {
      expect(() => createReportRunCommand({ format: 'json' })).toThrow(
        ReportRunCommandValidationError,
      );
      expect(() =>
        createReportRunCommand({
          preset: 'expenses',
          definitionId: 'aaaaaaaa-0000-4000-8000-000000000001',
          format: 'json',
        }),
      ).toThrow(ReportRunCommandValidationError);
    });
  });

  describe('FIX 1: Exchange rate conversion direction', () => {
    it('converts EUR to USD using the available EUR/USD rate', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as {
        id: string;
        status: string;
        downloadUrl: string | null;
      };
      expect(body.status).toBe('queued');
      expect(body.downloadUrl).toBeNull();
      expect(inMemoryStorage.uploadCallCount).toBe(0);

      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.jobStatus).toBe('completed');
      expect(finished.runStatus).toBe('completed');
      expect(finished.downloadUrl).toEqual(expect.any(String));

      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      expect(uploaded).toBeDefined();

      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      const eurRow = grid.rows.find((r) => r.key.includes(catExpenseId));
      expect(eurRow).toBeDefined();
      // 100.00 EUR (10000 minor) * 1.10 = 11000 USD minor
      const convertedCell = eurRow?.cells.find(
        (c) => c.measure === 'converted_value',
      );
      expect(convertedCell?.value).toBe('11000');
    });

    it('selects exchange rates at the frozen as-of instant, not a later-effective rate', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const link = await admin.query<{ job_id: string; asOf: string }>(
        `select r.job_id::text as job_id, j.payload->>'asOf' as "asOf"
           from public.report_runs r
           join public.jobs j on j.id = r.job_id
          where r.id = $1::uuid`,
        [body.id],
      );
      const asOf = link.rows[0]?.asOf;
      if (!asOf) {
        throw new Error('Expected a frozen asOf on the queued report job');
      }
      const laterEffectiveAt = new Date(
        new Date(asOf).getTime() + 1,
      ).toISOString();
      await admin.query(
        `insert into public.exchange_rates (
           workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by
         ) values ($1, 'EUR', 'USD', 2.00, $2::timestamptz, 'manual', $3)`,
        [workspace1Id, laterEffectiveAt, ownerId],
      );
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.jobStatus).toBe('completed');
      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      expect(uploaded).toBeDefined();
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      const eurRow = grid.rows.find((r) => r.key.includes(catExpenseId));
      const convertedCell = eurRow?.cells.find(
        (c) => c.measure === 'converted_value',
      );
      expect(convertedCell?.value).toBe('11000');
    });
  });

  describe('FIX 2: Budget join and empty budget policy', () => {
    it('fails the queued run when budget preset has no applicable budget in period', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'budget',
          format: 'json',
          filters: {
            from: '2026-07-01',
            to: '2026-07-31',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.jobStatus).toBe('failed');
      expect(finished.runStatus).toBe('failed');
      expect(JSON.stringify(finished.runError)).toContain(
        'No budget exists for the requested period.',
      );
    });

    it('returns 202 and warnings when budget preset has some unbudgeted buckets', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'budget',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);
      const uploaded = inMemoryStorage.uploaded.get(
        `${workspace1Id}/${body.id}.json`,
      );
      expect(uploaded).toBeDefined();
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(
        grid.warnings.some((w) => w.includes('bucket had no budget.')),
      ).toBe(true);
    });

    it('returns 202 with null cells and no error for custom definition with budget measure and no budget', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          definitionId: customDefId,
          format: 'json',
          filters: {
            from: '2026-07-01',
            to: '2026-07-31',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);
      const uploaded = inMemoryStorage.uploaded.get(
        `${workspace1Id}/${body.id}.json`,
      );
      expect(uploaded).toBeDefined();
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(grid.warnings).toEqual([]);
      const budgetCell = grid.rows[0]?.cells.find(
        (c) => c.measure === 'budget',
      );
      expect(budgetCell?.value).toBeNull();
    });
  });

  describe('FIX 3: Resource bounds (row cap, cell cap, string length)', () => {
    afterEach(() => {
      setReportSourceRowCap(REPORT_SOURCE_ROW_CAP);
      setReportGridCellCap(REPORT_GRID_CELL_CAP);
      setReportMaxCellStringLength(REPORT_MAX_CELL_STRING_LENGTH);
    });

    it('completes when source row count is exactly at the cap', async () => {
      // In June 2026 we have 2 transactions (txEurId and txEur2Id)
      setReportSourceRowCap(2);

      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.runStatus).toBe('completed');
    });

    it('fails the queued run when source row count is one over the cap', async () => {
      // 2 transactions in June, cap set to 1 -> one over the cap
      setReportSourceRowCap(1);

      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.runStatus).toBe('failed');
      expect(JSON.stringify(finished.runError)).toContain(
        'Report matched more source rows than the limit',
      );
    });

    it('completes when grid cell count is exactly at the cap', async () => {
      // expenses preset has 2 rows and 2 measures ('converted_value', 'percentage') -> 4 cells
      setReportGridCellCap(4);

      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.runStatus).toBe('completed');
    });

    it('fails the queued run when grid cell count is one over the cap', async () => {
      // expenses preset has 4 cells, cap set to 3 -> one over the cap
      setReportGridCellCap(3);

      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.runStatus).toBe('failed');
      expect(JSON.stringify(finished.runError)).toContain(
        'grid cells, exceeding the synchronous limit',
      );
    });

    it('fails the queued run when an individual cell string exceeds maximum allowed length', async () => {
      setReportMaxCellStringLength(5); // 'Expenses' is 8 chars, so it exceeds 5

      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.runStatus).toBe('failed');
      expect(JSON.stringify(finished.runError)).toContain(
        'Report cell string length exceeded maximum',
      );
    });
  });

  describe('FIX 4: Reversed period validation', () => {
    it('returns 422 with invalid-range on filters.to when from > to', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-30',
            to: '2026-06-01',
          },
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as {
        errors?: readonly { field: string; code: string; message: string }[];
      };
      expect(body.errors).toEqual([
        {
          field: 'filters.to',
          code: 'invalid-range',
          message: 'to must not be before from.',
        },
      ]);
    });
  });

  describe('FIX 8: Definition filters intersection', () => {
    it('applies saved definition type filter (expense) and excludes income transactions', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          definitionId: defExpenseOnlyId,
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);

      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      expect(uploaded).toBeDefined();

      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(grid.rows.length).toBeGreaterThan(0);
      const incomeRow = grid.rows.find((r) => r.key.includes(catIncomeId));
      expect(incomeRow).toBeUndefined();
      const expenseRow = grid.rows.find((r) => r.key.includes(catExpenseId));
      expect(expenseRow).toBeDefined();
    });

    it('returns empty row set when caller type filter conflicts with definition type filter', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          definitionId: defExpenseOnlyId,
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
            type: 'income',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);
      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(grid.rows).toEqual([]);
    });
  });

  describe('FIX 6: Behavioral endpoint integration suite', () => {
    it('excludes confirmed transaction with no qualifying postings (positive posting predicate)', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);
      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;

      // catExpenseId is present (confirmed with qualifying postings)
      const expenseRow = grid.rows.find((r) => r.key.includes(catExpenseId));
      expect(expenseRow).toBeDefined();

      // catNoPostingsId is excluded solely by the positive posting predicate
      const noPostingsRow = grid.rows.find((r) =>
        r.key.includes(catNoPostingsId),
      );
      expect(noPostingsRow).toBeUndefined();
    });

    it('excludes confirmed transaction with one pending sibling posting (negative posting predicate)', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);
      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;

      // catPendingPostingId is excluded solely by the negative posting predicate
      const pendingRow = grid.rows.find((r) =>
        r.key.includes(catPendingPostingId),
      );
      expect(pendingRow).toBeUndefined();
    });

    it('returns 404 for getReportRun cross-workspace access with dual-workspace member', async () => {
      // Create a report run in workspace 1 by dual member
      const createRes = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });
      expect(createRes.statusCode).toBe(202);
      const { id: runId } = JSON.parse(createRes.body) as { id: string };

      // Dual member attempts to read runId with x-workspace-id: workspace2Id
      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/report-runs/${runId}`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
        },
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 422 when unknown definitionId is requested across workspace boundaries with dual member', async () => {
      // defW2Id exists in workspace 2; dual member requests it in workspace 1
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          definitionId: defW2Id,
          format: 'json',
          filters: {},
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as {
        errors?: readonly { field: string; code: string; message: string }[];
      };
      expect(body.errors).toEqual([
        {
          field: 'definitionId',
          code: 'invalid',
          message: 'Report definition was not found.',
        },
      ]);
    });

    it('intersects preset and caller filters returning empty row set when disjoint', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: {
            type: 'income',
            from: '2026-06-01',
            to: '2026-06-30',
          },
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');
      await drainUntilRunTerminal(body.id);
      const artifactPath = `${workspace1Id}/${body.id}.json`;
      const uploaded = inMemoryStorage.uploaded.get(artifactPath);
      const grid = JSON.parse(uploaded!.content.toString('utf8')) as ReportGrid;
      expect(grid.rows).toEqual([]);
    });

    it('replays response for idempotent request with no second database row and no second uploaded artifact', async () => {
      const idemKey = randomUUID();
      const payload = {
        preset: 'expenses',
        format: 'json',
        filters: {
          from: '2026-06-01',
          to: '2026-06-30',
        },
      };

      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload,
      });
      expect(res1.statusCode).toBe(202);
      const body1 = JSON.parse(res1.body) as { id: string };

      const uploadCountBefore = inMemoryStorage.uploadCallCount;
      const dbRunsBefore = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.report_runs where workspace_id = $1`,
        [workspace1Id],
      );
      const dbCountBefore = parseInt(dbRunsBefore.rows[0]?.count ?? '0', 10);

      const res2 = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload,
      });
      expect(res2.statusCode).toBe(202);
      const body2 = JSON.parse(res2.body) as { id: string };
      expect(body2.id).toBe(body1.id);

      // Assert no second artifact upload and no second database row
      expect(inMemoryStorage.uploadCallCount).toBe(uploadCountBefore);
      const dbRunsAfter = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.report_runs where workspace_id = $1`,
        [workspace1Id],
      );
      const dbCountAfter = parseInt(dbRunsAfter.rows[0]?.count ?? '0', 10);
      expect(dbCountAfter).toBe(dbCountBefore);
    });

    it('retries a storage 5xx by overwriting the same object key', async () => {
      inMemoryStorage.failNext = ['unavailable'];
      const uploadsBefore = inMemoryStorage.uploadCallCount;
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: { from: '2026-06-01', to: '2026-06-30' },
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.runStatus).toBe('completed');
      expect(inMemoryStorage.uploadCallCount).toBe(uploadsBefore + 2);
      expect(
        inMemoryStorage.uploaded.has(`${workspace1Id}/${body.id}.json`),
      ).toBe(true);
    });

    it('fails the run permanently on a storage 4xx', async () => {
      inMemoryStorage.failNext = [400];
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: { from: '2026-06-01', to: '2026-06-30' },
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const finished = await drainUntilRunTerminal(body.id);
      expect(finished.jobStatus).toBe('failed');
      expect(finished.runStatus).toBe('failed');
    });

    it('fails with the 403 Problem when the creator is demoted before drain', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: { from: '2026-06-01', to: '2026-06-30' },
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string; status: string };
      expect(body.status).toBe('queued');

      await admin.query(
        `update public.workspace_memberships
            set role = 'viewer'
          where workspace_id = $1::uuid
            and profile_id = $2::uuid`,
        [workspace1Id, editorId],
      );

      try {
        const finished = await drainUntilRunTerminal(body.id);
        expect(finished.jobStatus).toBe('failed');
        expect(finished.runStatus).toBe('failed');
        expect(finished.runError).toEqual(
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

    it('projects dead_letter as failed on the report run with the job error copied', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: { from: '2026-06-01', to: '2026-06-30' },
        },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { id: string };
      const link = await admin.query<{ job_id: string }>(
        `select job_id::text as job_id from public.report_runs where id = $1::uuid`,
        [body.id],
      );
      const jobId = link.rows[0]?.job_id;
      const problem = {
        type: 'https://savia.app/problems/job-exhausted',
        title: 'Job Retries Exhausted',
        status: 500,
        code: 'job_retries_exhausted',
        detail: 'poison report run',
        traceId: randomUUID(),
      };
      await admin.query(`select public.dead_letter_job($1::uuid, $2::jsonb)`, [
        jobId,
        JSON.stringify(problem),
      ]);
      const run = await admin.query<{
        status: string;
        error: Record<string, unknown> | null;
      }>(`select status, error from public.report_runs where id = $1::uuid`, [
        body.id,
      ]);
      const job = await admin.query<{
        status: string;
        error: Record<string, unknown> | null;
      }>(`select status, error from public.jobs where id = $1::uuid`, [jobId]);
      expect(job.rows[0]?.status).toBe('dead_letter');
      expect(run.rows[0]?.status).toBe('failed');
      expect(run.rows[0]?.error).toEqual(job.rows[0]?.error);
    });

    it('fails permanently without uploading when the object key carries a foreign workspace prefix', async () => {
      const handlers = workerModule.get<readonly JobHandler[] | JobHandler>(
        JOB_HANDLERS,
      );
      const list = Array.isArray(handlers) ? handlers : [handlers];
      const original = list.find((handler) => handler.jobType === 'report_run');
      if (!original) {
        throw new Error('Expected a registered report_run handler');
      }
      const misbound: RenderingJobHandler = {
        jobType: original.jobType,
        renderBudget: (original as RenderingJobHandler).renderBudget,
        parsePayload: (raw, execution) => {
          const record = raw as Record<string, unknown>;
          return original.parsePayload(
            {
              ...record,
              objectKey: `${workspace2Id}/${String(record.reportRunId)}.json`,
            },
            execution,
          );
        },
        compute: (context, client) => original.compute(context, client),
        render: original.render?.bind(original),
        store: original.store?.bind(original),
        persist: (context, computed, client) =>
          original.persist(context, computed, client),
      };
      runner.registerHandler(misbound);
      const uploadsBefore = inMemoryStorage.uploadCallCount;
      try {
        const response = await application.inject({
          method: 'POST',
          url: '/v1/report-runs',
          headers: {
            authorization: 'Bearer editor-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            preset: 'expenses',
            format: 'json',
            filters: { from: '2026-06-01', to: '2026-06-30' },
          },
        });
        expect(response.statusCode).toBe(202);
        const body = JSON.parse(response.body) as { id: string };
        const foreignKey = `${workspace2Id}/${body.id}.json`;
        const finished = await drainUntilRunTerminal(body.id);
        expect(finished.jobStatus).toBe('failed');
        expect(finished.jobError).toEqual(
          expect.objectContaining({ code: 'invalid_payload' }),
        );
        expect(inMemoryStorage.uploadCallCount).toBe(uploadsBefore);
        expect(inMemoryStorage.uploaded.has(foreignKey)).toBe(false);
      } finally {
        runner.registerHandler(original);
      }
    });

    it('does not complete a different queued run in the same workspace', async () => {
      const first = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: { from: '2026-06-01', to: '2026-06-30' },
        },
      });
      const second = await application.inject({
        method: 'POST',
        url: '/v1/report-runs',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          preset: 'expenses',
          format: 'json',
          filters: { from: '2026-06-01', to: '2026-06-30' },
        },
      });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      const runA = JSON.parse(first.body) as { id: string };
      const runB = JSON.parse(second.body) as { id: string };
      const links = await admin.query<{ id: string; job_id: string }>(
        `select id::text, job_id::text as job_id
           from public.report_runs
          where id = any($1::uuid[])`,
        [[runA.id, runB.id]],
      );
      const jobB = links.rows.find((row) => row.id === runB.id)?.job_id;
      const queuedB = await admin.query<{ msg_id: string }>(
        `select msg_id::text as msg_id
           from pgmq.q_savia_jobs
          where (message->>'job_id')::uuid = $1::uuid`,
        [jobB],
      );
      const msgId = queuedB.rows[0]?.msg_id;
      if (!msgId) {
        throw new Error('Expected a queued message for the second report run');
      }
      await admin.query(`select pgmq.delete('savia_jobs', $1::bigint)`, [
        msgId,
      ]);
      const handlers = workerModule.get<readonly JobHandler[] | JobHandler>(
        JOB_HANDLERS,
      );
      const list = Array.isArray(handlers) ? handlers : [handlers];
      const original = list.find((handler) => handler.jobType === 'report_run');
      if (!original) {
        throw new Error('Expected a registered report_run handler');
      }
      const swapped: RenderingJobHandler = {
        jobType: original.jobType,
        renderBudget: (original as RenderingJobHandler).renderBudget,
        parsePayload: (raw, execution) => {
          const record = raw as Record<string, unknown>;
          if (record.reportRunId === runA.id) {
            return original.parsePayload(
              {
                ...record,
                reportRunId: runB.id,
                objectKey: `${workspace1Id}/${runB.id}.json`,
              },
              execution,
            );
          }
          return original.parsePayload(raw, execution);
        },
        compute: (context, client) => original.compute(context, client),
        render: original.render?.bind(original),
        store: original.store?.bind(original),
        persist: (context, computed, client) =>
          original.persist(context, computed, client),
      };
      runner.registerHandler(swapped);
      const uploadsBefore = inMemoryStorage.uploadCallCount;
      const signsBefore = inMemoryStorage.signCallCount;
      try {
        const finished = await drainUntilRunTerminal(runA.id);
        expect(finished.jobStatus).toBe('failed');
        expect(finished.jobError).toEqual(
          expect.objectContaining({ code: 'invalid_payload' }),
        );
        const other = await admin.query<{ status: string }>(
          `select status from public.report_runs where id = $1::uuid`,
          [runB.id],
        );
        expect(other.rows[0]?.status).toBe('queued');
        expect(inMemoryStorage.uploadCallCount).toBe(uploadsBefore);
        expect(inMemoryStorage.signCallCount).toBe(signsBefore);
        expect(
          inMemoryStorage.uploaded.has(`${workspace1Id}/${runB.id}.json`),
        ).toBe(false);
      } finally {
        runner.registerHandler(original);
      }
    });

    it('rolls back the report run completion when persist throws after writing', async () => {
      const handlers = workerModule.get<readonly JobHandler[] | JobHandler>(
        JOB_HANDLERS,
      );
      const list = Array.isArray(handlers) ? handlers : [handlers];
      const original = list.find((handler) => handler.jobType === 'report_run');
      if (!original) {
        throw new Error('Expected a registered report_run handler');
      }
      const racing: RenderingJobHandler = {
        jobType: original.jobType,
        renderBudget: (original as RenderingJobHandler).renderBudget,
        parsePayload: (raw, execution) => original.parsePayload(raw, execution),
        compute: (context, client) => original.compute(context, client),
        render: original.render?.bind(original),
        store: original.store?.bind(original),
        persist: async (context, computed, client) => {
          await original.persist(context, computed, client);
          throw new Error('refuse after persist');
        },
      };
      runner.registerHandler(racing);
      try {
        const response = await application.inject({
          method: 'POST',
          url: '/v1/report-runs',
          headers: {
            authorization: 'Bearer editor-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            preset: 'expenses',
            format: 'json',
            filters: { from: '2026-06-01', to: '2026-06-30' },
          },
        });
        expect(response.statusCode).toBe(202);
        const body = JSON.parse(response.body) as { id: string };
        await runner.drainOnce();
        const run = await admin.query<{ status: string }>(
          `select status from public.report_runs where id = $1::uuid`,
          [body.id],
        );
        const job = await admin.query<{ status: string }>(
          `select j.status
             from public.jobs j
             join public.report_runs r on r.job_id = j.id
            where r.id = $1::uuid`,
          [body.id],
        );
        expect(run.rows[0]?.status).toBe('queued');
        expect(job.rows[0]?.status).not.toBe('completed');
      } finally {
        runner.registerHandler(original);
      }
    });
  });
});
