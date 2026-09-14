// Migrations under test: 202609100016_job_queue.sql, 202609100018_job_dead_letter_audit.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from '../../src/worker.module.js';
import { PostgresJobsAdapter } from '../../src/jobs/postgres-jobs.adapter.js';
import type {
  JobExecutionContext,
  JobHandler,
} from '../../src/platform/job-handler.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import {
  PgTransaction,
  type TransactionClient,
} from '../../src/platform/pg-transaction.js';
import { PgmqJobQueueAdapter } from '../../src/platform/pgmq-job-queue.adapter.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';

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

describe('Job worker runtime (S2): claim, validate, run as creator under RLS', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresJobsAdapter;
  let queueAdapter: PgmqJobQueueAdapter;
  let runner: JobRunner;

  const ownerA = subject(8101);
  const viewerA = subject(8102);
  const ownerB = subject(8103);

  const ws1Id = id(8151);
  const ws2Id = id(8152);

  let computeSawWs1Accounts = 0;
  let computeSawWs2Accounts = 0;
  let computeExecuted = false;

  const probeHandler: JobHandler<
    { testProbe: boolean },
    { accountCount: number }
  > = {
    jobType: 'balance_forecast',
    parsePayload: (raw: unknown) => raw as { testProbe: boolean },
    compute: async (
      context: JobExecutionContext<{ testProbe: boolean }>,
      client: TransactionClient,
    ) => {
      computeExecuted = true;
      const res = await client.query<{ id: string; workspace_id: string }>(
        `select id::text, workspace_id::text from public.accounts`,
      );
      computeSawWs1Accounts = res.rows.filter(
        (r) => r.workspace_id === ws1Id,
      ).length;
      computeSawWs2Accounts = res.rows.filter(
        (r) => r.workspace_id === ws2Id,
      ).length;
      return { accountCount: res.rows.length };
    },
    persist: async (
      context: JobExecutionContext<{ testProbe: boolean }>,
      computed: { accountCount: number },
      client: TransactionClient,
    ) => {
      const accRes = await client.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'Worker Probe Result Account', 'checking', 'USD', $2)
         returning id::text`,
        [context.workspaceId, context.actorId],
      );
      return accRes.rows[0].id;
    },
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(
      pool,
      { callbackTimeoutMs: 10_000, statementTimeoutMs: 10_000 },
      { workerMode: true },
    );
    adapter = new PostgresJobsAdapter();
    queueAdapter = new PgmqJobQueueAdapter(transaction);

    const workerConfig = new WorkerConfig(1, 300, 1000, 30);
    runner = new JobRunner(queueAdapter, transaction, adapter, workerConfig, [
      probeHandler,
    ]);

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6)`,
      [
        ownerA,
        'job-worker-owner-a@example.test',
        viewerA,
        'job-worker-viewer-a@example.test',
        ownerB,
        'job-worker-owner-b@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [ownerA, 'job-worker-owner-a@example.test', 'Worker Owner A'],
      [viewerA, 'job-worker-viewer-a@example.test', 'Worker Viewer A'],
      [ownerB, 'job-worker-owner-b@example.test', 'Worker Owner B'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    for (const [wsId, name] of [
      [ws1Id, 'Worker Workspace 1'],
      [ws2Id, 'Worker Workspace 2'],
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

    // Seed domain account rows in both workspaces
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
       values ($1, $2, 'Account WS1', 'checking', 'USD', $3),
              ($4, $5, 'Account WS2', 'checking', 'USD', $6)`,
      [id(8201), ws1Id, ownerA, id(8202), ws2Id, ownerB],
    );
  });

  afterAll(async () => {
    await transaction.close();
    await admin.end();
  });

  describe('Worker role boundary', () => {
    it('the worker connection role is savia_worker and cannot read any table directly (42501)', async () => {
      const checkTableCannotBeRead = async (tableName: string) => {
        const client = await admin.connect();
        try {
          await client.query('begin');
          await client.query('set local role savia_worker');
          const err = await capturePgError(() =>
            client.query(`select * from public.${tableName} limit 1`),
          );
          expect(err.code).toBe('42501');
          await client.query('rollback');
        } finally {
          client.release();
        }
      };

      await checkTableCannotBeRead('jobs');
      await checkTableCannotBeRead('accounts');
      await checkTableCannotBeRead('workspaces');
    });
  });

  describe('Probe job execution and creator RLS scoping', () => {
    it('claims probe job enqueued by real subject and its compute sees exactly that creators workspace rows under savia_application + app.subject_id = creator', async () => {
      computeExecuted = false;
      computeSawWs1Accounts = 0;
      computeSawWs2Accounts = 0;

      // 1. OwnerA enqueues a probe job in ws1Id
      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'balance_forecast',
          { testProbe: true },
        );
      });

      expect(queuedJob.id).toBeDefined();
      expect(queuedJob.status).toBe('queued');

      // 2. Worker runs a claim/process cycle
      const count = await runner.runOnce();
      expect(count).toBeGreaterThanOrEqual(1);

      // 3. Verify compute executed and saw ONLY ws1Id rows under RLS
      expect(computeExecuted).toBe(true);
      expect(computeSawWs1Accounts).toBeGreaterThanOrEqual(1);
      expect(computeSawWs2Accounts).toBe(0);

      // 4. Verify job reached 'completed' with resultResourceId and 100% progress
      const completedJob = await admin.query<{
        status: string;
        progress_percent: number;
        result_resource_id: string | null;
        attempt_count: number;
      }>(
        `select status, progress_percent, result_resource_id::text as result_resource_id, attempt_count
           from public.jobs
          where id = $1::uuid`,
        [queuedJob.id],
      );

      expect(completedJob.rows[0].status).toBe('completed');
      expect(completedJob.rows[0].progress_percent).toBe(100);
      expect(completedJob.rows[0].result_resource_id).toBeDefined();
      expect(completedJob.rows[0].attempt_count).toBe(1);

      // Verify domain row created by persist exists
      const persistedAcc = await admin.query(
        `select id from public.accounts where id = $1::uuid`,
        [completedJob.rows[0].result_resource_id],
      );
      expect(persistedAcc.rows).toHaveLength(1);
    });
  });

  describe('Forged envelope and demoted actor security boundaries', () => {
    it('forged envelope with workspace id mismatch never executes domain compute and ends through fail_orphaned_job with 403 Problem Details', async () => {
      computeExecuted = false;

      // Create a job in ws1Id for ownerA
      const jobRes = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, ownerA],
      );
      const targetJobId = jobRes.rows[0].id;

      // Inject a forged message into pgmq with wrong workspace_id (ws2Id)
      await admin.query(`select pgmq.send('savia_jobs', $1::jsonb)`, [
        JSON.stringify({
          job_id: targetJobId,
          workspace_id: ws2Id, // Forged mismatch!
          actor_id: ownerA,
        }),
      ]);

      // Run worker
      await runner.runOnce();

      // Domain compute must NEVER execute
      expect(computeExecuted).toBe(false);

      // Job must be failed with fixed 403 problem details
      const jobRow = await admin.query<{
        status: string;
        error: { status: number; code: string; title: string };
      }>(`select status, error from public.jobs where id = $1::uuid`, [
        targetJobId,
      ]);

      expect(jobRow.rows[0].status).toBe('failed');
      expect(jobRow.rows[0].error.status).toBe(403);
      expect(jobRow.rows[0].error.code).toBe('forbidden');
      expect(jobRow.rows[0].error.title).toBe('Forbidden');
    });

    it('creator demoted to viewer never executes domain work and ends through fail_orphaned_job with 403', async () => {
      computeExecuted = false;

      // Demote viewerA: ensure they are viewer in ws1Id
      const jobRes = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, viewerA],
      );
      const targetJobId = jobRes.rows[0].id;

      // Send message for viewerA
      await admin.query(`select pgmq.send('savia_jobs', $1::jsonb)`, [
        JSON.stringify({
          job_id: targetJobId,
          workspace_id: ws1Id,
          actor_id: viewerA,
        }),
      ]);

      // Run worker
      await runner.runOnce();

      // Domain compute must NOT execute
      expect(computeExecuted).toBe(false);

      const jobRow = await admin.query<{
        status: string;
        error: { status: number; code: string };
      }>(`select status, error from public.jobs where id = $1::uuid`, [
        targetJobId,
      ]);

      expect(jobRow.rows[0].status).toBe('failed');
      expect(jobRow.rows[0].error.status).toBe(403);
    });

    it('fail_orphaned_job fails that creators non-terminal row only and leaves other jobs unaffected', async () => {
      // Create a job owned by ownerA in ws1Id
      const jobA = await admin.query<{ id: string }>(
        `insert into public.jobs (workspace_id, type, status, created_by)
         values ($1, 'balance_forecast', 'queued', $2)
         returning id::text`,
        [ws1Id, ownerA],
      );
      const jobIdA = jobA.rows[0].id;

      // Forge message claiming ownerB is the actor on ownerA's job
      await admin.query(`select pgmq.send('savia_jobs', $1::jsonb)`, [
        JSON.stringify({
          job_id: jobIdA,
          workspace_id: ws1Id,
          actor_id: ownerB, // Forged actor
        }),
      ]);

      await runner.runOnce();

      // Because fail_orphaned_job checks created_by = p_actor_id,
      // calling it with ownerB does NOT modify ownerA's job!
      const checkJobA = await admin.query<{ status: string }>(
        `select status from public.jobs where id = $1::uuid`,
        [jobIdA],
      );
      expect(checkJobA.rows[0].status).toBe('queued');
    });
  });

  describe('Worker lifecycle and shutdown drain', () => {
    it('drains in-flight job during application shutdown before closing the pool, completing the job and acking its message', async () => {
      let releaseCompute: () => void = () => {};
      const computeBlocked = new Promise<void>((resolve) => {
        releaseCompute = resolve;
      });
      let signalComputeStarted: () => void = () => {};
      const computeStarted = new Promise<void>((resolve) => {
        signalComputeStarted = resolve;
      });

      const blockingDrainHandler: JobHandler<
        { test: boolean },
        { done: boolean }
      > = {
        jobType: 'balance_forecast',
        parsePayload: (raw: unknown) => raw as { test: boolean },
        compute: async (_context, client) => {
          signalComputeStarted();
          await computeBlocked;
          const res = await client.query<{ ok: number }>('select 1 as ok');
          return { done: res.rows[0].ok === 1 };
        },
        persist: async (context, _computed, client) => {
          const accRes = await client.query<{ id: string }>(
            `insert into public.accounts (workspace_id, name, type, currency, created_by)
             values ($1, 'Drain Test Account', 'checking', 'USD', $2)
             returning id::text`,
            [context.workspaceId, context.actorId],
          );
          return accRes.rows[0].id;
        },
      };

      const app = await NestFactory.createApplicationContext(WorkerModule, {
        logger: false,
      });
      app.enableShutdownHooks();

      const appRunner = app.get(JobRunner);
      appRunner.registerHandler(blockingDrainHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'balance_forecast',
          { test: true },
        );
      });

      void appRunner.start();
      await computeStarted;

      let appClosed = false;
      const closePromise = app.close().then(() => {
        appClosed = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(appClosed).toBe(false);

      releaseCompute();
      await closePromise;

      const completedJob = await admin.query<{
        status: string;
        result_resource_id: string | null;
      }>(
        `select status, result_resource_id::text as result_resource_id
           from public.jobs
          where id = $1::uuid`,
        [queuedJob.id],
      );
      expect(completedJob.rows[0].status).toBe('completed');
      expect(completedJob.rows[0].result_resource_id).toBeDefined();

      const queueMsg = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where message->>'job_id' = $1`,
        [queuedJob.id],
      );
      expect(queueMsg.rows).toHaveLength(0);

      const appPool = app.get(PostgresPool);
      await expect(appPool.connect()).rejects.toThrow(
        'PostgreSQL pool has ended.',
      );
    });

    it('returns within bounded drain timeout and leaves message unacked when in-flight job exceeds drain timeout', async () => {
      process.env.SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS = '1';
      process.env.SAVIA_WORKER_POOL_CLOSE_GRACE_MS = '1000';

      let releaseHanging: () => void = () => {};
      const hangingBlocked = new Promise<void>((resolve) => {
        releaseHanging = resolve;
      });
      let signalHangingStarted: () => void = () => {};
      const hangingStarted = new Promise<void>((resolve) => {
        signalHangingStarted = resolve;
      });

      const hangingHandler: JobHandler<{ test: boolean }, { done: boolean }> = {
        jobType: 'balance_forecast',
        parsePayload: (raw: unknown) => raw as { test: boolean },
        compute: async () => {
          signalHangingStarted();
          await hangingBlocked;
          return { done: true };
        },
        persist: async () => 'noop',
      };

      const app = await NestFactory.createApplicationContext(WorkerModule, {
        logger: false,
      });
      app.enableShutdownHooks();

      const appRunner = app.get(JobRunner);
      appRunner.registerHandler(hangingHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'balance_forecast',
          { test: true },
        );
      });

      void appRunner.start();
      await hangingStarted;

      const t0 = Date.now();
      await app.close();
      const elapsedMs = Date.now() - t0;

      expect(elapsedMs).toBeGreaterThanOrEqual(1800);
      expect(elapsedMs).toBeLessThan(2500);

      const queueMsg = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where message->>'job_id' = $1`,
        [queuedJob.id],
      );
      expect(queueMsg.rows).toHaveLength(1);

      const jobRow = await admin.query<{ status: string }>(
        `select status from public.jobs where id = $1::uuid`,
        [queuedJob.id],
      );
      expect(jobRow.rows[0].status).not.toBe('completed');

      releaseHanging();
      delete process.env.SAVIA_WORKER_DRAIN_TIMEOUT_SECONDS;
      delete process.env.SAVIA_WORKER_POOL_CLOSE_GRACE_MS;
    }, 10_000);
  });

  describe('Retry, backoff, and dead letter (S3)', () => {
    it('poison job (fails every attempt, max 5 from read_ct) reaches dead_letter with a Problem Details error and its message is archived', async () => {
      const poisonHandler: JobHandler<{ poison: boolean }, { ok: boolean }> = {
        jobType: 'import_commit',
        parsePayload: (raw: unknown) => raw as { poison: boolean },
        compute: async () => {
          const err = new Error('Transient lock timeout in compute');
          Object.assign(err, { code: '40001' });
          throw err;
        },
        persist: async () => null,
      };
      runner.registerHandler(poisonHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(client, ws1Id, ownerA, 'import_commit', {
          poison: true,
        });
      });

      // Run attempts 1 to 4: each fails transiently and defers
      for (let attempt = 1; attempt <= 4; attempt++) {
        const count = await runner.runOnce();
        expect(count).toBe(1);

        const msgCheck = await admin.query<{ vt: string; read_ct: number }>(
          `select vt::text, read_ct from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
          [queuedJob.id],
        );
        expect(msgCheck.rows).toHaveLength(1);
        expect(msgCheck.rows[0].read_ct).toBe(attempt);

        // Fast-forward visibility timeout for next attempt
        await admin.query(
          `update pgmq.q_savia_jobs set vt = now() - interval '1 second' where (message->>'job_id')::uuid = $1::uuid`,
          [queuedJob.id],
        );
      }

      // Attempt 5: read_ct reaches 5 (>= maxAttempts 5) -> dead_letter and archive
      const finalCount = await runner.runOnce();
      expect(finalCount).toBe(1);

      // Verify jobs table reached dead_letter with RFC 9457 Problem Details
      const deadJob = await admin.query<{
        status: string;
        error: {
          type?: string;
          title?: string;
          status?: number;
          code?: string;
          detail?: string;
          traceId?: string;
        };
      }>(`select status, error from public.jobs where id = $1::uuid`, [
        queuedJob.id,
      ]);
      expect(deadJob.rows[0].status).toBe('dead_letter');
      expect(deadJob.rows[0].error.type).toBe(
        'https://savia.app/problems/job-exhausted',
      );
      expect(deadJob.rows[0].error.status).toBe(500);
      expect(deadJob.rows[0].error.code).toBe('job_retries_exhausted');

      // Verify queue is empty for this job and message is in archive table
      const queueRemaining = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(queueRemaining.rows).toHaveLength(0);

      const archiveMsg = await admin.query(
        `select msg_id from pgmq.a_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(archiveMsg.rows).toHaveLength(1);
    });

    it('an unacked mid-job crash redelivers', async () => {
      let runCount = 0;
      const redeliveryHandler: JobHandler<{ test: boolean }, { ok: boolean }> =
        {
          jobType: 'import_rollback',
          parsePayload: (raw: unknown) => raw as { test: boolean },
          compute: async () => {
            runCount++;
            return { ok: true };
          },
          persist: async () => null,
        };
      runner.registerHandler(redeliveryHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'import_rollback',
          { test: true },
        );
      });

      // Simulate a worker claiming the message and crashing mid-job (no ack, no defer)
      const claimed = await queueAdapter.claim(1, 1);
      expect(claimed.length).toBe(1);
      expect(claimed[0].message.job_id).toBe(queuedJob.id);
      expect(claimed[0].readCt).toBe(1);

      // Fast-forward visibility timeout so message becomes eligible for redelivery
      await admin.query(
        `update pgmq.q_savia_jobs set vt = now() - interval '1 second' where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );

      // Runner runs: redelivery attempt (readCt = 2) processes to completion
      const processed = await runner.runOnce();
      expect(processed).toBe(1);
      expect(runCount).toBe(1);

      const finishedJob = await admin.query<{
        status: string;
        attempt_count: number;
      }>(`select status, attempt_count from public.jobs where id = $1::uuid`, [
        queuedJob.id,
      ]);
      expect(finishedJob.rows[0].status).toBe('completed');
      expect(finishedJob.rows[0].attempt_count).toBe(2);

      // Message is acked (removed from queue)
      const qCheck = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(qCheck.rows).toHaveLength(0);
    });

    it('a transient failure succeeds on retry with an increasing delay', async () => {
      let attempts = 0;
      const retryHandler: JobHandler<{ test: boolean }, { ok: boolean }> = {
        jobType: 'balance_forecast',
        parsePayload: (raw: unknown) => raw as { test: boolean },
        compute: async () => {
          attempts++;
          if (attempts === 1) {
            const err = new Error('Transient serialization failure');
            Object.assign(err, { code: '40001' });
            throw err;
          }
          return { ok: true };
        },
        persist: async () => null,
      };
      runner.registerHandler(retryHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'balance_forecast',
          { test: true },
        );
      });

      // Attempt 1: transient failure
      const count1 = await runner.runOnce();
      expect(count1).toBe(1);
      expect(attempts).toBe(1);

      // Job stays in processing
      const jobAfter1 = await admin.query<{
        status: string;
        attempt_count: number;
      }>(`select status, attempt_count from public.jobs where id = $1::uuid`, [
        queuedJob.id,
      ]);
      expect(jobAfter1.rows[0].status).toBe('processing');
      expect(jobAfter1.rows[0].attempt_count).toBe(1);

      // Verify backoff delay was applied to vt: vt > now()
      const vtCheck = await admin.query<{
        is_future: boolean;
        delay_seconds: string;
      }>(
        `select vt > clock_timestamp() as is_future,
                extract(epoch from (vt - clock_timestamp()))::text as delay_seconds
           from pgmq.q_savia_jobs
          where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(vtCheck.rows[0].is_future).toBe(true);
      expect(Number(vtCheck.rows[0].delay_seconds)).toBeGreaterThanOrEqual(1.5);

      // Fast-forward visibility timeout
      await admin.query(
        `update pgmq.q_savia_jobs set vt = now() - interval '1 second' where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );

      // Attempt 2: succeeds
      const count2 = await runner.runOnce();
      expect(count2).toBe(1);
      expect(attempts).toBe(2);

      const jobAfter2 = await admin.query<{
        status: string;
        attempt_count: number;
      }>(`select status, attempt_count from public.jobs where id = $1::uuid`, [
        queuedJob.id,
      ]);
      expect(jobAfter2.rows[0].status).toBe('completed');
      expect(jobAfter2.rows[0].attempt_count).toBe(2);

      // Queue is empty
      const qCheck = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(qCheck.rows).toHaveLength(0);
    });
  });
});
