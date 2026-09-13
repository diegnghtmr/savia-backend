// Migrations under test: 202609100016_job_queue.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('Job queue outbox (S1): pgmq precondition, wrappers, transactional enqueue', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresJobsAdapter;

  const ownerA = subject(7101);
  const viewerA = subject(7102);
  const ownerB = subject(7103);

  const ws1Id = id(7151);
  const ws2Id = id(7152);

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
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    adapter = new PostgresJobsAdapter();

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6)`,
      [
        ownerA,
        'job-queue-owner-a@example.test',
        viewerA,
        'job-queue-viewer-a@example.test',
        ownerB,
        'job-queue-owner-b@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [ownerA, 'job-queue-owner-a@example.test', 'Queue Owner A'],
      [viewerA, 'job-queue-viewer-a@example.test', 'Queue Viewer A'],
      [ownerB, 'job-queue-owner-b@example.test', 'Queue Owner B'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    for (const [wsId, name] of [
      [ws1Id, 'Queue Workspace 1'],
      [ws2Id, 'Queue Workspace 2'],
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

  describe('Preconditions and pgmq environment', () => {
    it('pins pg_extension.extversion = 1.5.1 for pgmq', async () => {
      const result = await admin.query<{ extversion: string }>(
        `select extversion from pg_extension where extname = 'pgmq'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].extversion).toBe('1.5.1');
    });

    it('proves the queue pgmq.q_savia_jobs exists', async () => {
      const result = await admin.query<{ exists: boolean }>(
        `select to_regclass('pgmq.q_savia_jobs') is not null as exists`,
      );
      expect(result.rows[0]?.exists).toBe(true);
    });

    it('resolves pgmq procedures send, read, archive, delete, set_vt with to_regprocedure', async () => {
      const procs = await admin.query<{ regproc: string; proname: string }>(
        `select p.proname, p.oid::regprocedure::text as regproc
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'pgmq'
            and p.proname in ('send', 'read', 'archive', 'delete', 'set_vt')
          order by p.proname`,
      );

      const names = new Set(procs.rows.map((r) => r.proname));
      expect(names.has('send')).toBe(true);
      expect(names.has('read')).toBe(true);
      expect(names.has('archive')).toBe(true);
      expect(names.has('delete')).toBe(true);
      expect(names.has('set_vt')).toBe(true);

      for (const row of procs.rows) {
        const check = await admin.query<{ proc: string | null }>(
          `select to_regprocedure($1)::text as proc`,
          [row.regproc],
        );
        expect(check.rows[0]?.proc).toBe(row.regproc);
      }
    });
  });

  describe('Security definer wrappers and role grants', () => {
    it('keeps every queue security-definer wrapper owned by savia_elevated with NOBYPASSRLS and search_path set', async () => {
      const result = await admin.query<{
        proname: string;
        owner: string;
        rolbypassrls: boolean;
        rolsuper: boolean;
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(`
        select procedure.proname,
               owner.rolname as owner,
               owner.rolbypassrls,
               owner.rolsuper,
               procedure.prosecdef,
               procedure.proconfig
          from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
          join pg_roles owner on owner.oid = procedure.proowner
         where namespace.nspname = 'public'
           and procedure.proname in (
             'enqueue_job',
             'claim_jobs',
             'ack_job',
             'archive_job',
             'defer_job',
             'fail_orphaned_job'
           )
         order by procedure.proname
      `);

      expect(result.rows).toEqual([
        {
          proname: 'ack_job',
          owner: 'savia_elevated',
          rolbypassrls: false,
          rolsuper: false,
          prosecdef: true,
          proconfig: ['search_path=pg_catalog, public'],
        },
        {
          proname: 'archive_job',
          owner: 'savia_elevated',
          rolbypassrls: false,
          rolsuper: false,
          prosecdef: true,
          proconfig: ['search_path=pg_catalog, public'],
        },
        {
          proname: 'claim_jobs',
          owner: 'savia_elevated',
          rolbypassrls: false,
          rolsuper: false,
          prosecdef: true,
          proconfig: ['search_path=pg_catalog, public'],
        },
        {
          proname: 'defer_job',
          owner: 'savia_elevated',
          rolbypassrls: false,
          rolsuper: false,
          prosecdef: true,
          proconfig: ['search_path=pg_catalog, public'],
        },
        {
          proname: 'enqueue_job',
          owner: 'savia_elevated',
          rolbypassrls: false,
          rolsuper: false,
          prosecdef: true,
          proconfig: ['search_path=pg_catalog, public'],
        },
        {
          proname: 'fail_orphaned_job',
          owner: 'savia_elevated',
          rolbypassrls: false,
          rolsuper: false,
          prosecdef: true,
          proconfig: ['search_path=pg_catalog, public'],
        },
      ]);
    });

    it('enforces least-privilege execute grants: enqueue_job to savia_application, worker functions to savia_worker only', async () => {
      // PUBLIC must have no EXECUTE
      for (const fn of [
        'enqueue_job(uuid)',
        'claim_jobs(integer,integer)',
        'ack_job(bigint)',
        'archive_job(bigint)',
        'defer_job(bigint,integer)',
        'fail_orphaned_job(uuid,uuid)',
      ]) {
        const publicExec = await admin.query<{ has: boolean }>(
          `select has_function_privilege('public', 'public.' || $1, 'execute') as has`,
          [fn],
        );
        expect(publicExec.rows[0].has).toBe(false);
      }

      // savia_application can execute only enqueue_job
      const appEnqueue = await admin.query<{ has: boolean }>(
        `select has_function_privilege('savia_application', 'public.enqueue_job(uuid)', 'execute') as has`,
      );
      expect(appEnqueue.rows[0].has).toBe(true);

      const appClaim = await admin.query<{ has: boolean }>(
        `select has_function_privilege('savia_application', 'public.claim_jobs(integer,integer)', 'execute') as has`,
      );
      expect(appClaim.rows[0].has).toBe(false);

      // savia_worker can execute worker functions but not enqueue_job
      const workerEnqueue = await admin.query<{ has: boolean }>(
        `select has_function_privilege('savia_worker', 'public.enqueue_job(uuid)', 'execute') as has`,
      );
      expect(workerEnqueue.rows[0].has).toBe(false);

      const workerClaim = await admin.query<{ has: boolean }>(
        `select has_function_privilege('savia_worker', 'public.claim_jobs(integer,integer)', 'execute') as has`,
      );
      expect(workerClaim.rows[0].has).toBe(true);
    });

    it('rejects direct pgmq table queries from savia_application with 42501', async () => {
      const errorQ = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query('select * from pgmq.q_savia_jobs limit 1'),
        ),
      );
      expect(errorQ.code).toBe('42501');

      const errorA = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query('select * from pgmq.a_savia_jobs limit 1'),
        ),
      );
      expect(errorA.code).toBe('42501');
    });
  });

  describe('Transactional outbox: same-transaction commit and rollback proof', () => {
    it('commits a job row and its pgmq pointer message together in the same transaction', async () => {
      const payload = { testRun: true, asOf: '2026-09-13T00:00:00.000Z' };

      const createdJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'balance_forecast',
          payload,
        );
      });

      expect(createdJob.id).toBeDefined();
      expect(createdJob.status).toBe('queued');

      // Verify the job row exists in public.jobs
      const jobRow = await admin.query<{
        id: string;
        status: string;
        payload: unknown;
        attempt_count: number;
      }>(
        `select id::text, status, payload, attempt_count
           from public.jobs
          where id = $1::uuid`,
        [createdJob.id],
      );
      expect(jobRow.rows).toHaveLength(1);
      expect(jobRow.rows[0].status).toBe('queued');
      expect(jobRow.rows[0].attempt_count).toBe(0);
      expect(jobRow.rows[0].payload).toEqual(payload);

      // Verify the message in pgmq.q_savia_jobs
      const msgRes = await admin.query<{
        msg_id: string;
        message: { job_id: string; workspace_id: string };
      }>(
        `select msg_id::text, message
           from pgmq.q_savia_jobs
          where message->>'job_id' = $1`,
        [createdJob.id],
      );
      expect(msgRes.rows).toHaveLength(1);
      // Pointer message contains job_id and workspace_id ONLY - no payload or secret
      expect(msgRes.rows[0].message).toEqual({
        job_id: createdJob.id,
        workspace_id: ws1Id,
      });
      expect(msgRes.rows[0].message).not.toHaveProperty('payload');
      expect(msgRes.rows[0].message).not.toHaveProperty('secret');
    });

    it('rolls back both the job row and the pgmq message when the transaction aborts', async () => {
      let abortedJobId: string | undefined;

      await expect(
        transaction.run(ownerA, async (client) => {
          const job = await adapter.createQueuedJob(
            client,
            ws1Id,
            ownerA,
            'balance_forecast',
            { rollbackProof: true },
          );
          abortedJobId = job.id;
          throw new Error('Simulated mid-transaction failure');
        }),
      ).rejects.toThrow('Simulated mid-transaction failure');

      expect(abortedJobId).toBeDefined();

      // Neither job row nor pgmq message must exist
      const jobRow = await admin.query(
        `select id from public.jobs where id = $1::uuid`,
        [abortedJobId],
      );
      expect(jobRow.rows).toHaveLength(0);

      const msgRow = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where message->>'job_id' = $1`,
        [abortedJobId],
      );
      expect(msgRow.rows).toHaveLength(0);
    });

    it('prevents cross-workspace or foreign-subject enqueue in enqueue_job', async () => {
      // 1. Insert a queued job directly for ownerA in ws1Id
      const insertRes = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, ownerA],
      );
      const foreignJobId = insertRes.rows[0].id;

      // 2. Attempt to enqueue foreignJobId as ownerB (who is in ws2Id)
      const foreignError = await capturePgError(() =>
        asSubject(ownerB, async (client) => {
          await client.query(`select public.enqueue_job($1::uuid)`, [
            foreignJobId,
          ]);
        }),
      );
      // Fails because ownerB does not own or have role in ws1Id
      expect(foreignError.message).toMatch(
        /Cannot enqueue job|lacks active|not found|cannot be enqueued/i,
      );
    });
  });

  describe('Finding 1: Idempotent publication and single publication per job', () => {
    it('returns the same message id and publishes exactly once when enqueue_job is called twice for the same job', async () => {
      const insertRes = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, ownerA],
      );
      const jobId = insertRes.rows[0].id;

      const firstCall = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ msg_id: string }>(
          `select public.enqueue_job($1::uuid) as msg_id`,
          [jobId],
        );
        return res.rows[0].msg_id;
      });

      const secondCall = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ msg_id: string }>(
          `select public.enqueue_job($1::uuid) as msg_id`,
          [jobId],
        );
        return res.rows[0].msg_id;
      });

      expect(firstCall).toBeDefined();
      expect(secondCall).toBe(firstCall);

      const msgRes = await admin.query<{ msg_id: string }>(
        `select msg_id::text from pgmq.q_savia_jobs where message->>'job_id' = $1`,
        [jobId],
      );
      expect(msgRes.rows).toHaveLength(1);
      expect(msgRes.rows[0].msg_id).toBe(String(firstCall));
    });

    it('publishes exactly one message when two concurrent connections call enqueue_job for the same job', async () => {
      const insertRes = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, ownerA],
      );
      const jobId = insertRes.rows[0].id;

      const client1 = await admin.connect();
      const client2 = await admin.connect();

      try {
        await client1.query('begin');
        await client1.query('set local role savia_application');
        await client1.query("select set_config('app.subject_id', $1, true)", [
          ownerA,
        ]);

        await client2.query('begin');
        await client2.query('set local role savia_application');
        await client2.query("select set_config('app.subject_id', $1, true)", [
          ownerA,
        ]);

        let firstFinished: 'client1' | 'client2' | undefined;
        const p1 = client1
          .query<{
            msg_id: string;
          }>(`select public.enqueue_job($1::uuid) as msg_id`, [jobId])
          .then((res) => {
            firstFinished = firstFinished ?? 'client1';
            return res;
          });

        const p2 = client2
          .query<{
            msg_id: string;
          }>(`select public.enqueue_job($1::uuid) as msg_id`, [jobId])
          .then((res) => {
            firstFinished = firstFinished ?? 'client2';
            return res;
          });

        // The client that acquires the row lock finishes enqueue_job first.
        // It must commit to release the lock so the blocked client can inspect the committed marker.
        await Promise.race([p1, p2]);

        if (firstFinished === 'client1') {
          await client1.query('commit');
          await p2;
          await client2.query('commit');
        } else {
          await client2.query('commit');
          await p1;
          await client1.query('commit');
        }

        const [res1, res2] = await Promise.all([p1, p2]);

        expect(res1.rows[0].msg_id).toBeDefined();
        expect(res2.rows[0].msg_id).toBe(res1.rows[0].msg_id);

        const msgRes = await admin.query<{ msg_id: string }>(
          `select msg_id::text from pgmq.q_savia_jobs where message->>'job_id' = $1`,
          [jobId],
        );
        expect(msgRes.rows).toHaveLength(1);
      } finally {
        client1.release();
        client2.release();
      }
    });

    it('rejects savia_application writing the marker column queue_message_id with 42501', async () => {
      const insertRes = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, ownerA],
      );
      const jobId = insertRes.rows[0].id;

      const updateErr = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `update public.jobs set queue_message_id = 12345 where id = $1::uuid`,
            [jobId],
          );
        }),
      );
      expect(updateErr.code).toBe('42501');

      const insertErr = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, created_by, queue_message_id)
             values ($1, 'balance_forecast', 'queued', $2, 12345)`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(insertErr.code).toBe('42501');
    });
  });
});
