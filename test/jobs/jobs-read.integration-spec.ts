// Migrations under test: 202608310001_jobs.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_READ_OUTCOMES,
  type JobReadFound,
} from '../../src/jobs/job.port.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { PostgresJobsAdapter } from '../../src/jobs/postgres-jobs.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('JobsService getJob database boundary and isolation', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresJobsAdapter;
  let service: JobsService;

  const subjectDualMember = subject(4001); // Member of ws1 and ws2
  const subjectViewer = subject(4002); // Viewer in ws1
  const subjectNonMember = subject(4003); // Non-member

  const workspace1Id = id(4051);
  const workspace2Id = id(4052);
  const absentWorkspaceId = id(4099);

  const jobW1CompletedId = id(4101);
  const jobW1QueuedId = id(4102);
  const jobW1FailedId = id(4103);
  const jobW2CompletedId = id(4104);
  const absentJobId = id(4199);

  const resourceId = id(4201);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    adapter = new PostgresJobsAdapter();
    service = new JobsService(transaction, adapter);

    // 1. Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)`,
      [
        subjectDualMember,
        'jobs-read-dual@example.test',
        subjectViewer,
        'jobs-read-viewer@example.test',
        subjectNonMember,
        'jobs-read-nonmember@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectDualMember, 'jobs-read-dual@example.test', 'Jobs Dual Member'],
      [subjectViewer, 'jobs-read-viewer@example.test', 'Jobs Viewer'],
      [subjectNonMember, 'jobs-read-nonmember@example.test', 'Jobs Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 3. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Jobs Read Workspace One'],
      [workspace2Id, 'Jobs Read Workspace Two'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [wsId, name],
      );
    }

    // 4. Memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($3, $2, 'owner', 'active'),
              ($1, $4, 'viewer', 'active')`,
      [workspace1Id, subjectDualMember, workspace2Id, subjectViewer],
    );

    // 5. Jobs in Workspace 1
    // 5a. Completed job with resourceId
    await admin.query(
      `insert into public.jobs (
         id, workspace_id, type, status, progress_percent, result_resource_id, error,
         created_by, created_at, started_at, completed_at
       ) values ($1, $2, 'import_commit', 'completed', 100, $3, null, $4, '2026-08-31T12:00:00Z', '2026-08-31T12:00:01Z', '2026-08-31T12:00:10Z')`,
      [jobW1CompletedId, workspace1Id, resourceId, subjectDualMember],
    );

    // 5b. Queued job with null started_at, completed_at, progress_percent, result_resource_id, error
    await admin.query(
      `insert into public.jobs (
         id, workspace_id, type, status, progress_percent, result_resource_id, error,
         created_by, created_at, started_at, completed_at
       ) values ($1, $2, 'import_rollback', 'queued', null, null, null, $3, '2026-08-31T12:05:00Z', null, null)`,
      [jobW1QueuedId, workspace1Id, subjectDualMember],
    );

    // 5c. Failed job with error jsonb
    await admin.query(
      `insert into public.jobs (
         id, workspace_id, type, status, progress_percent, result_resource_id, error,
         created_by, created_at, started_at, completed_at
       ) values ($1, $2, 'import_commit', 'failed', 45, null, '{"type":"https://savia.app/problems/bad-request","title":"Invalid import statement","status":400}'::jsonb, $3, '2026-08-31T12:10:00Z', '2026-08-31T12:10:01Z', '2026-08-31T12:10:05Z')`,
      [jobW1FailedId, workspace1Id, subjectDualMember],
    );

    // 6. Job in Workspace 2
    await admin.query(
      `insert into public.jobs (
         id, workspace_id, type, status, progress_percent, result_resource_id, error,
         created_by, created_at, started_at, completed_at
       ) values ($1, $2, 'import_commit', 'completed', 100, null, null, $3, '2026-08-31T12:15:00Z', '2026-08-31T12:15:01Z', '2026-08-31T12:15:08Z')`,
      [jobW2CompletedId, workspace2Id, subjectDualMember],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(
        `delete from public.jobs where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
      await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
        workspace1Id,
        workspace2Id,
      ]);
      await admin.query(`delete from auth.users where id in ($1, $2, $3)`, [
        subjectDualMember,
        subjectViewer,
        subjectNonMember,
      ]);
      await admin.end();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('refuses access with forbidden (403) when caller has no active membership in workspace', async () => {
    const outcome = await service.getJob(
      subjectNonMember,
      workspace1Id,
      jobW1CompletedId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.FORBIDDEN);
  });

  it('refuses access with forbidden (403) when workspace does not exist', async () => {
    const outcome = await service.getJob(
      subjectDualMember,
      absentWorkspaceId,
      jobW1CompletedId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.FORBIDDEN);
  });

  it('returns not-found (404) when job does not exist in workspace', async () => {
    const outcome = await service.getJob(
      subjectDualMember,
      workspace1Id,
      absentJobId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.NOT_FOUND);
  });

  it('returns not-found (404, never 403) when job belongs to another workspace (RULING 66)', async () => {
    // Viewer is only member of workspace 1; requests job from workspace 2 under workspace 1
    const outcomeViewer = await service.getJob(
      subjectViewer,
      workspace1Id,
      jobW2CompletedId,
    );
    expect(outcomeViewer.kind).toBe(JOB_READ_OUTCOMES.NOT_FOUND);

    // Dual member is owner of both workspace 1 and 2; requests job from workspace 2 under workspace 1 header
    const outcomeDual = await service.getJob(
      subjectDualMember,
      workspace1Id,
      jobW2CompletedId,
    );
    expect(outcomeDual.kind).toBe(JOB_READ_OUTCOMES.NOT_FOUND);
  });

  it('adapter-level cross-tenant proof: findJobById directly with mismatched workspaceId returns undefined', async () => {
    await transaction.runRead(subjectDualMember, async (client) => {
      const mismatch = await adapter.findJobById(
        client,
        workspace1Id,
        jobW2CompletedId,
      );
      expect(mismatch).toBeUndefined();

      const match = await adapter.findJobById(
        client,
        workspace2Id,
        jobW2CompletedId,
      );
      expect(match).toBeDefined();
      expect(match?.id).toBe(jobW2CompletedId);
    });
  });

  it('reads completed job with resultResourceId (200 shape)', async () => {
    const outcome = await service.getJob(
      subjectDualMember,
      workspace1Id,
      jobW1CompletedId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.FOUND);
    const job = (outcome as JobReadFound).job;
    expect(job).toEqual({
      id: jobW1CompletedId,
      type: 'import_commit',
      status: 'completed',
      progressPercent: 100,
      resultResourceId: resourceId,
      error: null,
      createdAt: '2026-08-31T12:00:00.000Z',
      startedAt: '2026-08-31T12:00:01.000Z',
      completedAt: '2026-08-31T12:00:10.000Z',
    });
  });

  it('reads queued job with nullable fields as null (200 shape)', async () => {
    const outcome = await service.getJob(
      subjectDualMember,
      workspace1Id,
      jobW1QueuedId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.FOUND);
    const job = (outcome as JobReadFound).job;
    expect(job).toEqual({
      id: jobW1QueuedId,
      type: 'import_rollback',
      status: 'queued',
      progressPercent: null,
      resultResourceId: null,
      error: null,
      createdAt: '2026-08-31T12:05:00.000Z',
      startedAt: null,
      completedAt: null,
    });
  });

  it('reads failed job with error jsonb object verbatim (RULING 68)', async () => {
    const outcome = await service.getJob(
      subjectDualMember,
      workspace1Id,
      jobW1FailedId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.FOUND);
    const job = (outcome as JobReadFound).job;
    expect(job.status).toBe('failed');
    expect(job.progressPercent).toBe(45);
    expect(job.error).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid import statement',
      status: 400,
    });
  });

  it('admits a viewer because the select policy admits all four roles', async () => {
    const outcome = await service.getJob(
      subjectViewer,
      workspace1Id,
      jobW1CompletedId,
    );
    expect(outcome.kind).toBe(JOB_READ_OUTCOMES.FOUND);
    const job = (outcome as JobReadFound).job;
    expect(job.id).toBe(jobW1CompletedId);
  });
});
