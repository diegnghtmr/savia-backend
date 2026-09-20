// Migrations under test: 202609100018_job_dead_letter_audit.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { PostgresJobsAdapter } from '../../src/jobs/postgres-jobs.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PgmqJobQueueAdapter } from '../../src/platform/pgmq-job-queue.adapter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

type CapturedPgError = { code?: string; message?: string };

async function capturePgError(
  run: () => Promise<unknown>,
): Promise<CapturedPgError> {
  try {
    await run();
  } catch (error: unknown) {
    return error as CapturedPgError;
  }
  throw new Error('Expected statement to fail, but it succeeded.');
}

describe('Job transitions audit trail (S3): triggers, RLS, sequence, dead letter', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresJobsAdapter;
  let queueAdapter: PgmqJobQueueAdapter;

  const ownerA = subject(9101);
  const viewerA = subject(9102);
  const ownerB = subject(9103);

  const ws1Id = id(9151);
  const ws2Id = id(9152);

  async function asSubject<T>(
    subjectId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subjectId,
      ]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 10_000 });
    adapter = new PostgresJobsAdapter();
    queueAdapter = new PgmqJobQueueAdapter(transaction);

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6)`,
      [
        ownerA,
        'job-transitions-owner-a@example.test',
        viewerA,
        'job-transitions-viewer-a@example.test',
        ownerB,
        'job-transitions-owner-b@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [ownerA, 'job-transitions-owner-a@example.test', 'Transitions Owner A'],
      [
        viewerA,
        'job-transitions-viewer-a@example.test',
        'Transitions Viewer A',
      ],
      [ownerB, 'job-transitions-owner-b@example.test', 'Transitions Owner B'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    for (const [wsId, name] of [
      [ws1Id, 'Transitions Workspace 1'],
      [ws2Id, 'Transitions Workspace 2'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [wsId, name],
      );
    }

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'viewer', 'active'),
              ($4, $5, 'owner', 'active')`,
      [ws1Id, ownerA, viewerA, ws2Id, ownerB],
    );
  });

  afterAll(async () => {
    await transaction.close();
    await admin.end();
  });

  it('proves definer trigger identity insert needs no explicit sequence grant to savia_elevated and composite-FK check works under forced RLS', async () => {
    const queued = await transaction.run(ownerA, async (client) => {
      return adapter.createQueuedJob(
        client,
        ws1Id,
        ownerA,
        'balance_forecast',
        { test: 1 },
      );
    });

    // Check directly under admin that a transition row was inserted by the definer trigger
    const transitions = await admin.query<{
      id: string;
      workspace_id: string;
      job_id: string;
      from_status: string | null;
      to_status: string;
      attempt: number;
      error: unknown;
    }>(
      `select id::text, workspace_id::text, job_id::text, from_status, to_status, attempt, error
         from public.job_transitions
        where job_id = $1::uuid`,
      [queued.id],
    );

    expect(transitions.rows).toHaveLength(1);
    expect(Number(transitions.rows[0].id)).toBeGreaterThan(0);
    expect(transitions.rows[0].workspace_id).toBe(ws1Id);
    expect(transitions.rows[0].job_id).toBe(queued.id);
    expect(transitions.rows[0].from_status).toBeNull();
    expect(transitions.rows[0].to_status).toBe('queued');
    expect(transitions.rows[0].attempt).toBe(0);
    expect(transitions.rows[0].error).toBeNull();
  });

  it('records exact transition sequence for transient twice then success: [(null,queued,0),(queued,processing,1),(processing,processing,2),(processing,processing,3),(processing,completed,3)] in (occurred_at,id) order', async () => {
    // 1. Enqueue (attempt 0)
    const job = await transaction.run(ownerA, async (client) => {
      return adapter.createQueuedJob(
        client,
        ws1Id,
        ownerA,
        'balance_forecast',
        { test: 'retry-sequence' },
      );
    });

    // 2. Attempt 1: start_job (attempt_count 1)
    await transaction.run(ownerA, async (client) => {
      await adapter.transitionToProcessing(client, ws1Id, job.id, 1);
    });

    // 3. Transient failure 1 -> redelivered -> start_job (attempt_count 2)
    await transaction.run(ownerA, async (client) => {
      await adapter.transitionToProcessing(client, ws1Id, job.id, 2);
    });

    // 4. Transient failure 2 -> redelivered -> start_job (attempt_count 3)
    await transaction.run(ownerA, async (client) => {
      await adapter.transitionToProcessing(client, ws1Id, job.id, 3);
    });

    // 5. Success -> complete_job (attempt_count stays 3)
    await transaction.run(ownerA, async (client) => {
      await adapter.completeJob(client, ws1Id, job.id, null);
    });

    // Query transitions in (occurred_at, id) order
    const result = await admin.query<{
      from_status: string | null;
      to_status: string;
      attempt: number;
    }>(
      `select from_status, to_status, attempt
         from public.job_transitions
        where job_id = $1::uuid
        order by occurred_at asc, id asc`,
      [job.id],
    );

    const sequence = result.rows.map((r) => [
      r.from_status,
      r.to_status,
      r.attempt,
    ]);

    expect(sequence).toEqual([
      [null, 'queued', 0],
      ['queued', 'processing', 1],
      ['processing', 'processing', 2],
      ['processing', 'processing', 3],
      ['processing', 'completed', 3],
    ]);
  });

  it('enforces RLS: transitions are readable by the creator and a viewer, while another workspace sees 0 rows', async () => {
    const job = await transaction.run(ownerA, async (client) => {
      return adapter.createQueuedJob(
        client,
        ws1Id,
        ownerA,
        'balance_forecast',
        { test: 'rls-visibility' },
      );
    });

    // Creator (ownerA) can read the transitions
    const creatorRows = await asSubject(ownerA, async (client) => {
      const res = await client.query(
        `select id, to_status from public.job_transitions where job_id = $1::uuid`,
        [job.id],
      );
      return res.rows;
    });
    expect(creatorRows.length).toBeGreaterThanOrEqual(1);

    // Viewer (viewerA) in same workspace can read the transitions
    const viewerRows = await asSubject(viewerA, async (client) => {
      const res = await client.query(
        `select id, to_status from public.job_transitions where job_id = $1::uuid`,
        [job.id],
      );
      return res.rows;
    });
    expect(viewerRows.length).toBeGreaterThanOrEqual(1);

    // Foreign workspace member (ownerB) sees 0 rows
    const foreignRows = await asSubject(ownerB, async (client) => {
      const res = await client.query(
        `select id, to_status from public.job_transitions where job_id = $1::uuid`,
        [job.id],
      );
      return res.rows;
    });
    expect(foreignRows).toHaveLength(0);
  });

  it('records dead_letter transition with error matching jobs.error and message in pgmq.a_savia_jobs for poison job', async () => {
    const problemDetails = {
      type: 'https://savia.app/problems/job-exhausted',
      title: 'Job Retries Exhausted',
      status: 500,
      code: 'job_retries_exhausted',
      detail: 'Job exceeded maximum retry attempts (5).',
      traceId: randomUUID(),
    };

    // 1. Enqueue job
    const job = await transaction.run(ownerA, async (client) => {
      return adapter.createQueuedJob(
        client,
        ws1Id,
        ownerA,
        'balance_forecast',
        { test: 'poison-job' },
      );
    });

    // 2. Claim message via queue
    const claimed = await queueAdapter.claim(1, 30);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const msg = claimed.find((m) => m.message.job_id === job.id);
    expect(msg).toBeDefined();

    // 3. Move job to dead_letter via adapter, THEN archive the message
    await transaction.run(ownerA, async (client) => {
      await adapter.deadLetter(client, ws1Id, job.id, problemDetails);
    });
    await queueAdapter.archive(msg!.msgId);

    // 4. Verify jobs table has dead_letter and error
    const jobCheck = await admin.query<{ status: string; error: unknown }>(
      `select status, error from public.jobs where id = $1::uuid`,
      [job.id],
    );
    expect(jobCheck.rows[0].status).toBe('dead_letter');
    expect(jobCheck.rows[0].error).toEqual(problemDetails);

    // 5. Verify transition row has to_status = dead_letter and error equals jobs.error
    const lastTransition = await admin.query<{
      to_status: string;
      error: unknown;
    }>(
      `select to_status, error
         from public.job_transitions
        where job_id = $1::uuid
        order by occurred_at desc, id desc
        limit 1`,
      [job.id],
    );
    expect(lastTransition.rows[0].to_status).toBe('dead_letter');
    expect(lastTransition.rows[0].error).toEqual(jobCheck.rows[0].error);

    // 6. Verify message sits in pgmq archive table
    const archiveCheck = await admin.query<{
      msg_id: string;
      message: unknown;
    }>(
      `select msg_id::text as msg_id, message
         from pgmq.a_savia_jobs
        where (message->>'job_id')::uuid = $1::uuid`,
      [job.id],
    );
    expect(archiveCheck.rows).toHaveLength(1);
    expect(archiveCheck.rows[0].msg_id).toBe(String(msg!.msgId));
  });

  it('leaves 0 transition rows when enqueue transaction rolls back', async () => {
    let rolledBackJobId: string | undefined;

    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        ownerA,
      ]);

      const res = await client.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1::uuid, 'balance_forecast', 'queued', $2::uuid)
         returning id::text`,
        [ws1Id, ownerA],
      );
      rolledBackJobId = res.rows[0].id;

      // Roll back
      await client.query('rollback');
    } finally {
      client.release();
    }

    expect(rolledBackJobId).toBeDefined();
    const check = await admin.query(
      `select count(*) as count from public.job_transitions where job_id = $1::uuid`,
      [rolledBackJobId],
    );
    expect(Number(check.rows[0].count)).toBe(0);
  });

  it('rejects direct INSERT, UPDATE, and DELETE on public.job_transitions for savia_application with 42501', async () => {
    const hasInsertPriv = await admin.query<{ has_priv: boolean }>(
      `select has_table_privilege('savia_application', 'public.job_transitions', 'insert') as has_priv`,
    );
    expect(hasInsertPriv.rows[0].has_priv).toBe(false);

    // Direct INSERT -> 42501 table privilege denial
    const insertErr = await capturePgError(() =>
      asSubject(ownerA, (client) =>
        client.query(
          `insert into public.job_transitions (workspace_id, job_id, from_status, to_status, attempt, occurred_at)
           values ($1::uuid, $2::uuid, null, 'queued', 0, clock_timestamp())`,
          [ws1Id, id(9876)],
        ),
      ),
    );
    expect(insertErr.code).toBe('42501');
    expect(insertErr.message).toMatch(
      /permission denied for table job_transitions/,
    );

    // Direct UPDATE -> 42501
    const updateErr = await capturePgError(() =>
      asSubject(ownerA, (client) =>
        client.query(`update public.job_transitions set to_status = 'failed'`),
      ),
    );
    expect(updateErr.code).toBe('42501');

    // Direct DELETE -> 42501
    const deleteErr = await capturePgError(() =>
      asSubject(ownerA, (client) =>
        client.query(`delete from public.job_transitions`),
      ),
    );
    expect(deleteErr.code).toBe('42501');
  });
});
