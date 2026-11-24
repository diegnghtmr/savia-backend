// Migrations under test: 202609100016_job_queue.sql, 202609100018_job_dead_letter_audit.sql,
// 202609170008_recurring_job_type.sql, 202609170009_frankfurter_pairs.sql,
// 202609170011_recurring_creator_lock.sql, 202609170013_budget_alert_discovery.sql,
// 202609170014_notification_delivery.sql, 202609170016_notification_settings.sql,
// 202609170017_subscription_detection.sql, 202609170018_b6_alert_recipients.sql,
// 202609170020_notification_mute_at_creation.sql, 202609170036_integration_check_constraints.sql
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from '../../src/worker.module.js';
import { FrankfurterRateJob } from '../../src/currencies/frankfurter-rate-job.js';
import { PostgresJobsAdapter } from '../../src/jobs/postgres-jobs.adapter.js';
import {
  NotificationDeliverySweep,
  PostgresNotificationDeliveryStore,
  type NotificationClaim,
} from '../../src/notifications/notification-delivery-sweep.js';
import { ExpoPushAdapter } from '../../src/notifications/notification-providers.adapter.js';
import { PostgresNotificationSettingsAdapter } from '../../src/notifications/postgres-notification-settings.adapter.js';
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
import * as tesseractAdapter from '../../src/platform/system-tesseract.adapter.js';
import { WorkerConfig } from '../../src/platform/worker-config.js';
import { DeliveryDeadlineExceededError } from '../../src/platform/delivery-deadline.js';
import { RecurringJobSweep } from '../../src/recurring/recurring-job-sweep.js';
import { RecurringService } from '../../src/recurring/recurring.service.js';
import { PostgresRecurringAdapter } from '../../src/recurring/postgres-recurring.adapter.js';
import { createSubscriptionListQuery } from '../../src/recurring/subscription-query.js';
import { PostgresOccurrenceAdapter } from '../../src/recurring/postgres-occurrence.adapter.js';
import { PostgresWorkspaceMemberAdapter } from '../../src/identity/postgres-workspace-member.adapter.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { NotificationService } from '../../src/notifications/notification.service.js';
import { PostgresNotificationAdapter } from '../../src/notifications/postgres-notification.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';

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

  it('sends each reached budget threshold once, only to the active creator in the current period', async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const category = id(8161);
    const now = new Date().toISOString();
    const budgets = [
      [id(8171), 'Groceries', ownerA, day(-1), day(1), 1000],
      [id(8172), 'Expired', ownerA, day(-5), day(-4), 1],
      [id(8173), 'Non-member', ownerB, day(-1), day(1), 1],
      [id(8174), 'No plan', ownerA, day(-1), day(1), 0],
    ] as const;
    const idempotency = new PostgresIdempotencyAdapter();
    const ledger = new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      idempotency,
    );
    const notifications = new NotificationService(
      transaction,
      new PostgresNotificationAdapter(),
      idempotency,
    );
    const list = async (subject: string) =>
      (
        await notifications.listNotifications(subject, {
          subject,
          limit: 50,
          unreadOnly: false,
        })
      ).page.items;
    const spend = async (
      amountMinor: string,
      status: 'draft' | 'confirmed' = 'confirmed',
      occurredAt = now,
    ) => {
      const result = await ledger.create(
        ownerA,
        ws1Id,
        {
          type: 'expense',
          accountId: id(8201),
          amount: { currency: 'USD', amountMinor },
          occurredAt,
          categoryId: category,
          status,
        },
        randomUUID(),
      );
      expect(result.kind).toBe('created');
    };
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by)
      values ($1,$2,'Budget alert test','expense',$3)`,
      [category, ws1Id, ownerA],
    );
    for (const [budget, name, actor, start, end, planned] of budgets) {
      await admin.query(
        `insert into public.budgets (id, workspace_id, name, method, period_start, period_end, currency, created_by)
        values ($1,$2,$3,'envelope',$4,$5,'USD',$6)`,
        [budget, ws1Id, name, start, end, actor],
      );
      await admin.query(
        `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor)
        values ($1,$2,$3,$4)`,
        [ws1Id, budget, category, planned],
      );
    }
    await spend('1000', 'draft');
    await spend('1000', 'confirmed', `${day(-4)}T00:00:00Z`);
    await spend('799');
    const preflight = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    try {
      const appRunner = app.get(JobRunner);
      const sweep = async () => {
        await appRunner.start();
        await vi.waitFor(() => expect(appRunner.activeJobsCount).toBe(0));
        await appRunner.stop();
      };
      await sweep();
      expect(await list(ownerA)).toEqual([]);
      await spend('1');
      await sweep();
      const warning = await list(ownerA);
      expect(warning).toEqual([
        expect.objectContaining({
          type: 'budget_threshold_80',
          title: 'Budget “Groceries” reached 80%',
          read: false,
          body: null,
          actionUrl: null,
        }),
      ]);
      await spend('200');
      await sweep();
      const reached = await list(ownerA);
      expect(reached).toEqual([
        warning[0],
        expect.objectContaining({
          type: 'budget_threshold_100',
          title: 'Budget “Groceries” reached 100%',
          read: false,
          body: null,
          actionUrl: null,
        }),
      ]);
      await sweep();
      expect(await list(ownerA)).toEqual(reached);
      expect(await list(viewerA)).toEqual([]);
      expect(await list(ownerB)).toEqual([]);
    } finally {
      await app.close();
      preflight.mockRestore();
    }
  }, 10_000);

  it('confines budget discovery to the worker function, with no worker table access', async () => {
    const { rows } = await admin.query(`
      select r as role, has_function_privilege(r, f.oid, 'EXECUTE') as execute,
             has_any_column_privilege(r, 'public.budgets', 'SELECT') as read_budget,
             f.proconfig as config
      from pg_proc f cross join unnest(array['anon','authenticated','savia_application','savia_worker','service_role']) r
      where f.oid = to_regprocedure('public.find_budget_alert_targets(date,uuid)') order by role`);
    expect(rows).toEqual([
      {
        role: 'anon',
        execute: false,
        read_budget: false,
        config: ['search_path=pg_catalog, public'],
      },
      {
        role: 'authenticated',
        execute: false,
        read_budget: false,
        config: ['search_path=pg_catalog, public'],
      },
      {
        role: 'savia_application',
        execute: false,
        read_budget: true,
        config: ['search_path=pg_catalog, public'],
      },
      {
        role: 'savia_worker',
        execute: true,
        read_budget: false,
        config: ['search_path=pg_catalog, public'],
      },
      {
        role: 'service_role',
        execute: false,
        read_budget: false,
        config: ['search_path=pg_catalog, public'],
      },
    ]);
  });

  it('does not give a viewer access to the worker budget publisher or notification writes', async () => {
    const attemptedWrite = (sql: string, values: string[]) =>
      capturePgError(() =>
        transaction.run(viewerA, (client) => client.query(sql, values)),
      );
    expect(
      (
        await attemptedWrite(
          `select public.publish_budget_thresholds($1, $2, current_date, array[80])`,
          [ws1Id, id(8171)],
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await attemptedWrite(
          `insert into public.notifications (workspace_id, subject_id, type, resource_id, title)
      values ($1,$2,'budget_threshold_80',$3,'Should not be inserted')`,
          [ws1Id, viewerA, id(8171)],
        )
      ).code,
    ).toBe('42501');
  });

  it('proposes only regular confirmed expenses, preserves candidate identity, and alerts once per price change', async () => {
    const idempotency = new PostgresIdempotencyAdapter();
    const ledger = new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      idempotency,
    );
    const recurring = new RecurringService(
      transaction,
      new PostgresRecurringAdapter(),
      idempotency,
    );
    const notifications = new NotificationService(
      transaction,
      new PostgresNotificationAdapter(),
      idempotency,
    );
    const at = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString();
    const charge = async (
      description: string,
      days: number,
      amountMinor = '1000',
      payeeId?: string,
      status: 'draft' | 'confirmed' = 'confirmed',
    ) => {
      const result = await ledger.create(
        ownerA,
        ws1Id,
        {
          type: 'expense',
          accountId: id(8201),
          amount: { currency: 'USD', amountMinor },
          occurredAt: at(days),
          description,
          status,
          ...(payeeId === undefined ? {} : { payeeId }),
        },
        randomUUID(),
      );
      expect(result.kind).toBe('created');
    };
    for (const [offset, day] of [-92, -62, -32].entries())
      await charge(
        ['Stream Plus', 'stream   plus', 'STREAM PLUS'][offset]!,
        day,
      );
    for (const [offset, day] of [-15, -8, -1].entries())
      await charge('Weekly delivery', day, offset === 2 ? '900' : '1000');
    for (const day of [-732, -367, -2]) await charge('Annual licence', day);
    await charge('One-off', -1);
    for (const day of [-70, -34, -1]) await charge('Irregular', day);
    for (const [offset, day] of [-62, -32, -2].entries()) {
      const payee = id(8190 + offset);
      await admin.query(
        `insert into public.payees (id,workspace_id,name,created_by) values ($1,$2,$3,$4)`,
        [payee, ws1Id, `Shop ${offset}`, ownerA],
      );
      await charge('Same receipt description', day, '1000', payee);
      await charge('Draft only', day, '1000', undefined, 'draft');
      await charge('Unrelated prices', day, String(1000 * (offset + 1)));
    }
    await admin.query(
      `insert into public.subscriptions
      (workspace_id, payee_name, current_amount_minor, current_currency, previous_amount_minor, previous_currency, frequency, status, created_by)
      values ($1,'Legacy subscription',1100,'USD',1000,'USD','monthly','confirmed',$2)`,
      [ws2Id, ownerB],
    );
    const preflight = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    try {
      const appRunner = app.get(JobRunner);
      const sweep = async () => {
        await appRunner.start();
        await vi.waitFor(() => expect(appRunner.activeJobsCount).toBe(0));
        await appRunner.stop();
      };
      const list = async (actor = viewerA, workspaceId = ws1Id) => {
        const result = await recurring.listSubscriptions(
          actor,
          createSubscriptionListQuery({ workspaceId, statusParam: 'detected' }),
        );
        if (result.kind !== 'ok')
          throw new Error('Could not list detected subscriptions');
        return [...result.page.items].sort((a, b) =>
          a.frequency.localeCompare(b.frequency),
        );
      };
      const alerts = async (subject: string) =>
        (
          await notifications.listNotifications(subject, {
            subject,
            limit: 50,
            unreadOnly: false,
          })
        ).page.items.filter(
          ({ type }) => type === 'subscription_price_increase',
        );
      await sweep();
      const initial = await list();
      expect(initial).toEqual([
        expect.objectContaining({
          frequency: 'monthly',
          status: 'detected',
          currentAmount: { currency: 'USD', amountMinor: '1000' },
          increasePercent: 0,
        }),
        expect.objectContaining({
          frequency: 'weekly',
          status: 'detected',
          payeeName: 'Weekly delivery',
          increasePercent: -10,
        }),
        expect.objectContaining({
          frequency: 'yearly',
          status: 'detected',
          payeeName: 'Annual licence',
          increasePercent: 0,
        }),
      ]);
      expect(initial[0]?.payeeName.toLowerCase()).toBe('stream plus');
      expect(await list(ownerB, ws2Id)).toEqual([]);
      expect(
        await recurring.listSubscriptions(
          ownerB,
          createSubscriptionListQuery({ workspaceId: ws1Id }),
        ),
      ).toEqual({ kind: 'forbidden' });
      expect(await alerts(ownerA)).toEqual([]);
      const legacy = await alerts(ownerB);
      expect(legacy).toEqual([
        expect.objectContaining({
          title: 'Subscription “Legacy subscription” increased by 10%',
        }),
      ]);
      await charge('Stream Plus', -2, '1100');
      await sweep();
      const updated = await list();
      expect(updated).toEqual([
        {
          ...initial[0],
          payeeName: 'Stream Plus',
          currentAmount: { currency: 'USD', amountMinor: '1100' },
          increasePercent: 10,
          nextExpectedAt: expect.any(String),
        },
        initial[1],
        initial[2],
      ]);
      const increased = await alerts(ownerA);
      expect(increased).toEqual([
        expect.objectContaining({
          title: 'Subscription “Stream Plus” increased by 10%',
          body: null,
          actionUrl: null,
          read: false,
        }),
      ]);
      await sweep();
      expect(await list()).toEqual(updated);
      expect(await alerts(ownerA)).toEqual(increased);
      expect(await alerts(ownerB)).toEqual(legacy);
      expect(await alerts(viewerA)).toEqual([]);
      expect(
        (await admin.query('select id from public.recurring_rules')).rows,
      ).toEqual([]);
    } finally {
      await app.close();
      preflight.mockRestore();
    }
  }, 10_000);

  it('grants only worker execution of fixed-path subscription discovery, without direct table grants', async () => {
    const { rows } = await admin.query(`
      select r as role, has_function_privilege(r, f.oid, 'EXECUTE') as execute,
             f.proconfig as config
      from pg_proc f cross join unnest(array['anon','authenticated','savia_application','savia_worker','service_role']) r
      where f.oid = to_regprocedure('public.find_subscription_detection_targets(uuid)') order by role`);
    expect(rows).toEqual(
      [
        'anon',
        'authenticated',
        'savia_application',
        'savia_worker',
        'service_role',
      ].map((role) => ({
        role,
        execute: role === 'savia_worker',
        config: ['search_path=pg_catalog, public'],
      })),
    );
    const result = await transaction.runAsQueueConsumer((client) =>
      client.query(
        `select * from public.find_subscription_detection_targets(null)`,
      ),
    );
    expect(result.rows).toEqual([
      { workspaceId: ws1Id, subject: ownerA },
      { workspaceId: ws2Id, subject: ownerB },
    ]);
    for (const table of ['subscriptions', 'transactions', 'payees']) {
      const error = await capturePgError(() =>
        transaction.runAsQueueConsumer((client) =>
          client.query(`select 1 from public.${table}`),
        ),
      );
      expect(error.code).toBe('42501');
    }
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
    beforeEach(() => {
      // This suite exercises the worker runtime's claim/RLS/shutdown-drain
      // behavior through a real WorkerModule application context, which
      // imports ReceiptWorkerModule and therefore runs the real OCR startup
      // preflight on init. Stub it here so this suite does not depend on the
      // host having the tesseract "spa" language pack installed (CI installs
      // it; local dev machines may not) — OCR language pack coverage belongs
      // to the OCR-specific test suites, not this one.
      vi.spyOn(tesseractAdapter, 'runOcrStartupPreflight').mockResolvedValue(
        undefined,
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

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

    it('an unknown error thrown by compute is deferred (job stays processing) and ends in dead_letter at the attempt limit', async () => {
      const unknownErrorHandler: JobHandler<
        { test: boolean },
        { ok: boolean }
      > = {
        jobType: 'import_commit',
        parsePayload: (raw: unknown) => raw as { test: boolean },
        compute: async () => {
          throw new Error(
            'EPIPE: broken pipe on unexpected worker socket closure',
          );
        },
        persist: async () => null,
      };
      runner.registerHandler(unknownErrorHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(client, ws1Id, ownerA, 'import_commit', {
          test: true,
        });
      });

      // Attempt 1: fails with unknown error -> deferred, job stays in processing
      const count1 = await runner.runOnce();
      expect(count1).toBe(1);

      const jobAfter1 = await admin.query<{
        status: string;
        attempt_count: number;
      }>(`select status, attempt_count from public.jobs where id = $1::uuid`, [
        queuedJob.id,
      ]);
      expect(jobAfter1.rows[0].status).toBe('processing');
      expect(jobAfter1.rows[0].attempt_count).toBe(1);

      const msgCheck1 = await admin.query<{ vt: string; read_ct: number }>(
        `select vt::text, read_ct from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(msgCheck1.rows).toHaveLength(1);
      expect(msgCheck1.rows[0].read_ct).toBe(1);

      // Fast-forward visibility timeout for attempts 2 to 4
      for (let attempt = 2; attempt <= 4; attempt++) {
        await admin.query(
          `update pgmq.q_savia_jobs set vt = now() - interval '1 second' where (message->>'job_id')::uuid = $1::uuid`,
          [queuedJob.id],
        );

        const count = await runner.runOnce();
        expect(count).toBe(1);

        const jobRow = await admin.query<{
          status: string;
          attempt_count: number;
        }>(
          `select status, attempt_count from public.jobs where id = $1::uuid`,
          [queuedJob.id],
        );
        expect(jobRow.rows[0].status).toBe('processing');
        expect(jobRow.rows[0].attempt_count).toBe(attempt);
      }

      // Fast-forward for attempt 5: limit reached (read_ct 5 >= maxAttempts 5) -> dead_letter and archive
      await admin.query(
        `update pgmq.q_savia_jobs set vt = now() - interval '1 second' where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );

      const finalCount = await runner.runOnce();
      expect(finalCount).toBe(1);

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

      // Message removed from queue and present in archive
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

    it('acks a persist refusal when another delivery already completed the job', async () => {
      const raceHandler: JobHandler<{ race: boolean }, { ok: boolean }> = {
        jobType: 'import_rollback',
        parsePayload: (raw: unknown) => raw as { race: boolean },
        compute: async (context) => {
          await transaction.run(ownerA, async (writeClient) => {
            await adapter.completeJob(writeClient, ws1Id, context.jobId, null);
          });
          return { ok: true };
        },
        persist: async () => null,
      };
      runner.registerHandler(raceHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(
          client,
          ws1Id,
          ownerA,
          'import_rollback',
          {
            race: true,
          },
        );
      });

      const count = await runner.runOnce();
      expect(count).toBe(1);

      const jobRow = await admin.query<{ status: string }>(
        `select status from public.jobs where id = $1::uuid`,
        [queuedJob.id],
      );
      expect(jobRow.rows[0].status).toBe('completed');

      const queueRemaining = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(queueRemaining.rows).toHaveLength(0);
    });

    it('fails the job and acks when persist raises an unrelated P0001', async () => {
      const failingPersistHandler: JobHandler<
        { fail: boolean },
        { ok: boolean }
      > = {
        jobType: 'import_commit',
        parsePayload: (raw: unknown) => raw as { fail: boolean },
        compute: async () => ({ ok: true }),
        persist: async (_context, _computed, client) => {
          await client.query(
            "do $$ begin raise exception 'Report generation failed'; end $$",
          );
          return null;
        },
      };
      runner.registerHandler(failingPersistHandler);

      const queuedJob = await transaction.run(ownerA, async (client) => {
        return adapter.createQueuedJob(client, ws1Id, ownerA, 'import_commit', {
          fail: true,
        });
      });

      const count = await runner.runOnce();
      expect(count).toBe(1);

      const jobRow = await admin.query<{ status: string }>(
        `select status from public.jobs where id = $1::uuid`,
        [queuedJob.id],
      );
      expect(jobRow.rows[0].status).toBe('failed');

      const queueRemaining = await admin.query(
        `select msg_id from pgmq.q_savia_jobs where (message->>'job_id')::uuid = $1::uuid`,
        [queuedJob.id],
      );
      expect(queueRemaining.rows).toHaveLength(0);
    });

    it('bounds whole transaction lifetime when blocked on advisory lock during setup', async () => {
      const lockSubject = subject(9999);
      const blocker = await admin.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [lockSubject],
        );

        const start = Date.now();
        await expect(
          transaction.run(lockSubject, async () => 'ok', { timeoutMs: 1000 }),
        ).rejects.toThrow(DeliveryDeadlineExceededError);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(2500);

        // pg_stat_activity shows no active transaction for that connection
        const blockerPidRes = await blocker.query<{ pid: number }>(
          'select pg_backend_pid() as pid',
        );
        const blockerPid = blockerPidRes.rows[0].pid;

        const activeCheck = await admin.query<{ pid: number; state: string }>(
          `select pid, state from pg_stat_activity
            where query like '%hashtextextended%'
              and pid != pg_backend_pid()
              and pid != $1
              and state = 'active'`,
          [blockerPid],
        );
        expect(activeCheck.rows).toHaveLength(0);

        // The pool remains usable afterwards
        const probe = await transaction.run(ownerA, async (client) => {
          const res = await client.query<{ one: number }>('select 1 as one');
          return res.rows[0].one;
        });
        expect(probe).toBe(1);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
    });

    it('empirically verifies SET LOCAL transaction_timeout terminates a running transaction mid-transaction', async () => {
      const client = await admin.connect();
      client.on('error', () => undefined);
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL transaction_timeout = '500ms'");
        const start = Date.now();
        await expect(client.query('select pg_sleep(2)')).rejects.toThrow();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(400);
        expect(elapsed).toBeLessThan(1800);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release(true);
      }
    });

    it('sets transaction_timeout server-side for bounded transactions', async () => {
      let observedTimeout = '';
      await transaction.run(
        ownerA,
        async (client) => {
          const res = await client.query<{ timeout: string }>(
            "select current_setting('transaction_timeout') as timeout",
          );
          observedTimeout = res.rows[0].timeout;
        },
        undefined,
        undefined,
        5000,
      );
      expect(observedTimeout).toMatch(/^[1-9]\d*ms$/);
      expect(Number.parseInt(observedTimeout, 10)).toBeGreaterThan(0);
      expect(Number.parseInt(observedTimeout, 10)).toBeLessThanOrEqual(5000);
    });
  });

  registerRecurringAndAlertTests(
    () => ({ admin, transaction, adapter, queueAdapter }),
    { ownerA, ownerB, viewerA, ws1Id, ws2Id },
  );

  describe('Daily system FX job', () => {
    beforeAll(async () => {
      await admin.query(
        `
        insert into public.exchange_rates
          (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
        values ($1, 'EUR', 'USD', 1.1000, '2026-11-19', 'manual', $3),
               ($1, 'COP', 'USD', 0.00024, '2026-11-19', 'manual', $3),
               ($1, 'JPY', 'USD', 0.007, '2026-11-19', 'manual', $3),
               ($1, 'CHF', 'USD', 1.2, '2026-11-19', 'manual', $3),
               ($2, 'EUR', 'USD', 1.1000, '2026-11-19', 'manual', $4),
               ($2, 'GBP', 'USD', 1.25, '2026-11-19', 'manual', $4)`,
        [ws1Id, ws2Id, ownerA, ownerB],
      );
      await admin.query(
        `
        insert into public.accounts
          (workspace_id, name, type, currency, status, closed_at, created_by)
        values ($1, 'Euro 1', 'checking', 'EUR', 'active', null, $3),
               ($1, 'Euro 2', 'checking', 'EUR', 'active', null, $3),
               ($1, 'Peso', 'checking', 'COP', 'active', null, $3),
               ($1, 'Yen', 'checking', 'JPY', 'archived', null, $3),
               ($1, 'Franc', 'checking', 'CHF', 'closed', now(), $3),
               ($2, 'Euro', 'checking', 'EUR', 'active', null, $4),
               ($2, 'Pound', 'checking', 'GBP', 'active', null, $4)`,
        [ws1Id, ws2Id, ownerA, ownerB],
      );
    });

    it('only exposes distinct active account-to-workspace pairs to the worker', async () => {
      const sql = 'select * from public.list_frankfurter_pairs()';
      const pairs = await transaction.runAsQueueConsumer((client) =>
        client.query(sql),
      );
      expect(pairs.rows).toEqual([
        { workspace_id: ws1Id, base_currency: 'COP', quote_currency: 'USD' },
        { workspace_id: ws1Id, base_currency: 'EUR', quote_currency: 'USD' },
        { workspace_id: ws2Id, base_currency: 'EUR', quote_currency: 'USD' },
        { workspace_id: ws2Id, base_currency: 'GBP', quote_currency: 'USD' },
      ]);
      await expect(
        transaction.runRead(ownerA, (client) => client.query(sql)),
      ).rejects.toMatchObject({ code: '42501' });
      const exposed = await admin.query(`
        select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')
          and has_function_privilege(rolname, 'public.list_frankfurter_pairs()', 'execute')`);
      expect(exposed.rows).toEqual([]);
    });

    it('starts with the real worker, publishes a dated batch once, and writes nothing on partial provider outage', async () => {
      const requests: string[] = [];
      let date = '2026-11-20';
      let eur = '1.10000000000000008900';
      let unavailable = false;
      const server = createServer((req, res) => {
        if (req.url === '/currencies') {
          res.end(
            '{"EUR":"Euro","GBP":"Pound","USD":"Dollar","JPY":"Yen","CHF":"Franc"}',
          );
          return;
        }
        requests.push(req.url ?? '');
        const base = req.url === '/latest?from=EUR&to=USD' ? 'EUR' : 'GBP';
        if (unavailable && base === 'GBP') res.writeHead(503).end();
        else
          res.end(
            `{"amount":1,"base":"${base}","date":"${date}","rates":{"USD":${base === 'EUR' ? eur : '1.2500'}}}`,
          );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected loopback TCP.');
      const origin = `http://127.0.0.1:${address.port}`;
      vi.stubEnv('SAVIA_FRANKFURTER_BASE_URL', origin);
      vi.spyOn(tesseractAdapter, 'runOcrStartupPreflight').mockResolvedValue(
        undefined,
      );
      const localFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (!String(input).startsWith(`${origin}/`))
          throw new Error('Only loopback FX requests are permitted.');
        return localFetch(input, init);
      });
      const run = async () => {
        const app = await NestFactory.createApplicationContext(WorkerModule, {
          logger: false,
        });
        try {
          const runOnce = vi.spyOn(app.get(FrankfurterRateJob), 'runOnce');
          await app.get(JobRunner).start();
          expect(runOnce).toHaveBeenCalledOnce();
          await runOnce.mock.results[0].value;
        } finally {
          await app.close();
        }
      };
      const readRates = async () =>
        (
          await admin.query(`
        select id, workspace_id, base_currency, quote_currency, rate::text,
               effective_at as day, source, manual
          from public.exchange_rates order by id`)
        ).rows;
      try {
        const initial = await readRates();
        await run();
        const recorded = await readRates();
        expect(recorded.filter((row) => row.source === 'manual')).toEqual(
          initial,
        );
        expect(
          recorded
            .filter((row) => row.source === 'frankfurter')
            .map((r) => [
              r.workspace_id,
              r.base_currency,
              r.quote_currency,
              r.rate,
              r.day.toISOString(),
              r.manual,
            ])
            .sort(),
        ).toEqual([
          [ws1Id, 'EUR', 'USD', eur, '2026-11-20T00:00:00.000Z', false],
          [ws2Id, 'EUR', 'USD', eur, '2026-11-20T00:00:00.000Z', false],
          [ws2Id, 'GBP', 'USD', '1.2500', '2026-11-20T00:00:00.000Z', false],
        ]);
        eur = '9.99';
        await run();
        expect(await readRates()).toEqual(recorded);
        date = '2026-11-23';
        unavailable = true;
        await expect(run()).rejects.toThrow('Frankfurter returned HTTP 503.');
        expect(await readRates()).toEqual(recorded);
        expect(requests).toEqual(
          Array.from({ length: 3 }, () => [
            '/latest?from=EUR&to=USD',
            '/latest?from=GBP&to=USD',
          ]).flat(),
        );
      } finally {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    });
  });
});

describe('Notification delivery outbox', () => {
  const recipient = subject(9101);
  const peer = subject(9102);
  const email = 'notification-recipient@example.test';
  const authIds = [recipient, peer];
  let admin: Pool;
  let worker: PgTransaction;

  beforeAll(() => {
    admin = new Pool({ connectionString: url });
    worker = new PgTransaction(new PostgresPool(PostgresConfig.fromUrl(url!)), {
      callbackTimeoutMs: 5000,
    });
  });

  beforeEach(async () => {
    await admin.query(
      `insert into auth.users (id, email, email_confirmed_at)
       values ($1, $3, now()), ($2, 'notification-peer@example.test', now())`,
      [recipient, peer, email],
    );
  });

  afterEach(async () => {
    await admin.query('delete from auth.users where id = any($1::uuid[])', [
      authIds,
    ]);
  });

  afterAll(async () => {
    await worker.close();
    await admin.end();
  });

  async function notify(title: string, time?: string, user = recipient) {
    const notification = randomUUID();
    await admin.query(
      `insert into public.notifications (id, subject_id, type, title, created_at)
       values ($1, $2, 'report_available', $3, coalesce($4::timestamptz, now()))`,
      [notification, user, title, time ?? null],
    );
    return notification;
  }

  function claim(emailConfigured = true) {
    return worker.runAsQueueConsumer(async (client) => {
      const { rows } = await client.query<{
        delivery_id: string;
        lease_id: string;
        attempts: number;
        recipient: string;
        title: string;
        body: string | null;
      }>('select * from public.claim_notification_delivery($1)', [
        emailConfigured,
      ]);
      return rows[0];
    }, 5000);
  }

  function record(id: string, lease: string, outcome: string, seconds: number) {
    return worker.runAsQueueConsumer(async (client) => {
      const { rows } = await client.query<{ written: boolean }>(
        'select public.finish_notification_delivery($1, $2, $3, $4) as written',
        [id, lease, outcome, seconds],
      );
      return rows[0].written;
    }, 5000);
  }

  it('deduplicates channels, skips unregistered pushes without an attempt, and claims email only once across workers', async () => {
    const notification = await notify('Report available');
    await admin.query(
      `insert into public.notifications (id, subject_id, type, title)
       values ($1, $2, 'report_available', 'Duplicate') on conflict (id) do nothing`,
      [notification, recipient],
    );
    expect(await claim(false)).toBeUndefined();
    const [a, b] = await Promise.all([claim(), claim()]);
    const delivered = a ?? b;
    expect(a === undefined || b === undefined).toBe(true);
    expect(delivered).toMatchObject({
      recipient: email,
      title: 'Report available',
      attempts: 1,
    });
    expect(
      await record(delivered.delivery_id, delivered.lease_id, 'accepted', 5),
    ).toBe(true);
    expect(await claim()).toBeUndefined();
    const { rows } = await admin.query(
      `select channel, status, reason, attempts from public.notification_deliveries
       where notification_id = $1 order by channel`,
      [notification],
    );
    expect(rows).toEqual([
      { channel: 'email', status: 'accepted', reason: null, attempts: 1 },
      {
        channel: 'push',
        status: 'skipped',
        reason: 'no_push_device',
        attempts: 0,
      },
    ]);
  });

  it('sends one Expo delivery per active subject device and disables an unregistered device', async () => {
    const accepts = 'ExpoPushToken[active]';
    const unregisters = 'ExponentPushToken[gone]';
    await admin.query(
      `insert into public.push_devices (subject_id, expo_token, platform, app_version)
       values ($1, $3, 'ios', '1'), ($1, $4, 'android', '1'), ($2, 'ExpoPushToken[peer]', 'ios', '1')`,
      [recipient, peer, accepts, unregisters],
    );
    vi.spyOn(tesseractAdapter, 'runOcrStartupPreflight').mockResolvedValue(
      undefined,
    );
    const send = vi
      .spyOn(ExpoPushAdapter.prototype, 'deliver')
      .mockImplementation(async ({ to }) =>
        to === unregisters ? 'device_not_registered' : 'accepted',
      );
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    try {
      const sweep = app.get(NotificationDeliverySweep);
      const notification = await notify('Two devices');
      await sweep.runOnce();
      await sweep.runOnce();
      expect(send.mock.calls.map(([message]) => message.to).sort()).toEqual(
        [accepts, unregisters].sort(),
      );
      expect(
        send.mock.calls.every(([message]) => message.title === 'Two devices'),
      ).toBe(true);
      expect(
        new Set(send.mock.calls.map(([message]) => message.idempotencyKey))
          .size,
      ).toBe(2);
      const { rows } = await admin.query(
        `select status, reason, attempts from public.notification_deliveries
         where notification_id = $1 and push_device_id is not null order by status`,
        [notification],
      );
      expect(rows).toEqual([
        { status: 'accepted', reason: null, attempts: 1 },
        { status: 'failed', reason: 'device_not_registered', attempts: 1 },
      ]);
      send.mockClear();
      await notify('One active device');
      await sweep.runOnce();
      expect(send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ to: accepts, title: 'One active device' }),
      );
    } finally {
      send.mockRestore();
      vi.mocked(tesseractAdapter.runOcrStartupPreflight).mockRestore();
      await app.close();
    }
  });

  // Reviewer regression (verify mwr36929).
  it('preserves a registration renewed during an actual loopback Expo submission', async () => {
    const { createServer } = await import('node:http');
    const renewedToken = 'ExpoPushToken[reviewer-renewed]';
    const otherToken = 'ExpoPushToken[reviewer-other]';
    const registration = new PostgresNotificationSettingsAdapter();
    await worker.run(recipient, (client) =>
      registration.registerDevice(client, recipient, {
        expoPushToken: renewedToken,
        platform: 'ios',
        appVersion: '1',
      }),
    );
    await worker.run(recipient, (client) =>
      registration.registerDevice(client, recipient, {
        expoPushToken: otherToken,
        platform: 'android',
        appVersion: '1',
      }),
    );
    const calls: { path: string; to: string; title: string }[] = [];
    let renewed = false;
    let serverError: unknown;
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body);
        calls.push({
          path: request.url!,
          to: message.to,
          title: message.title,
        });
        if (!renewed && message.to === renewedToken) {
          const result = await worker.run(recipient, (client) =>
            registration.registerDevice(client, recipient, {
              expoPushToken: renewedToken,
              platform: 'ios',
              appVersion: '2',
            }),
          );
          renewed = result?.created === false;
          response.end(
            JSON.stringify({
              data: {
                status: 'error',
                details: { error: 'DeviceNotRegistered' },
              },
            }),
          );
        } else {
          response.end(
            JSON.stringify({ data: { status: 'ok', id: 'loopback-ticket' } }),
          );
        }
      } catch (error) {
        serverError = error;
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected loopback port');
    vi.stubEnv('SAVIA_EXPO_BASE_URL', `http://127.0.0.1:${address.port}`);
    const preflight = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    try {
      const app = await NestFactory.createApplicationContext(WorkerModule, {
        logger: false,
      });
      try {
        const sweep = app.get(NotificationDeliverySweep);
        const old = await notify('First event');
        await sweep.runOnce();
        expect(serverError).toBeUndefined();
        expect(renewed).toBe(true);
        const { rows } = await admin.query(
          `select d.expo_token, d.app_version, d.active, n.status, n.reason
           from public.notification_deliveries n join public.push_devices d on d.id = n.push_device_id
           where n.notification_id = $1 order by d.expo_token`,
          [old],
        );
        expect(rows).toEqual([
          {
            expo_token: otherToken,
            app_version: '1',
            active: true,
            status: 'accepted',
            reason: null,
          },
          {
            expo_token: renewedToken,
            app_version: '2',
            active: true,
            status: 'failed',
            reason: 'device_not_registered',
          },
        ]);
        await notify('Second event');
        await sweep.runOnce();
        expect(calls).toHaveLength(4);
        for (const title of ['First event', 'Second event']) {
          expect(
            calls
              .filter((call) => call.title === title)
              .map(({ path, to }) => [path, to])
              .sort(),
          ).toEqual([
            ['/--/api/v2/push/send', otherToken],
            ['/--/api/v2/push/send', renewedToken],
          ]);
        }
      } finally {
        await app.close();
      }
    } finally {
      preflight.mockRestore();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('does not submit a cached claim superseded in Postgres even if its cached deadline is in the future', async () => {
    await notify('Fenced send');
    const formerStore = new PostgresNotificationDeliveryStore(worker);
    const otherStore = new PostgresNotificationDeliveryStore(worker);
    const originalClaim = formerStore.claim.bind(formerStore);
    const acquired = Promise.withResolvers<NotificationClaim>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(formerStore, 'claim').mockImplementationOnce(
      async (emailConfigured) => {
        try {
          const original = await originalClaim(emailConfigured);
          if (original === undefined)
            throw new Error('Expected an email lease.');
          acquired.resolve(original);
          await release.promise;
          return original;
        } catch (error) {
          acquired.reject(error);
          throw error;
        }
      },
    );
    const provider = { deliver: vi.fn(async () => 'accepted' as const) };
    const formerRun = new NotificationDeliverySweep(
      formerStore,
      provider,
    ).runOnce();
    try {
      const old = await acquired.promise;
      await admin.query(
        `update public.notification_deliveries set available_at = now() - interval '1 second' where id = $1`,
        [old.delivery_id],
      );
      await new NotificationDeliverySweep(otherStore, provider).runOnce();
    } finally {
      release.resolve();
      await formerRun;
    }
    expect(provider.deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: email, title: 'Fenced send' }),
    );
  });

  it('defers overnight quiet hours in their own timezone without using an attempt', async () => {
    const {
      rows: [zone],
    } = await admin.query<{ name: string; ends: Date }>(
      `select name, (((now() at time zone name)::date +
                        case when (now() at time zone name)::time >= time '19:00' then 1 else 0 end)
                     + time '05:00') at time zone name as ends
         from (values ('Etc/GMT-1'), ('Etc/GMT+1'), ('Etc/GMT+8'), ('Etc/GMT-8')) zones(name)
        where (now() at time zone name)::time < time '04:30'
           or (now() at time zone name)::time >= time '19:30'
        limit 1`,
    );
    const notification = await notify('Quiet overnight');
    await admin.query(
      `insert into public.notification_delivery_preferences (subject_id, quiet_start, quiet_end, quiet_timezone)
       values ($1, '19:00', '05:00', $2)`,
      [recipient, zone.name],
    );
    expect(await claim()).toBeUndefined();
    const { rows } = await admin.query(
      `select status, attempts, available_at from public.notification_deliveries
        where notification_id = $1 and channel = 'email'`,
      [notification],
    );
    expect(rows).toEqual([
      { status: 'pending', attempts: 0, available_at: zone.ends },
    ]);
  });

  it('defers quiet hours without using an attempt', async () => {
    const notification = await notify('Quiet report');
    await admin.query(
      `insert into public.notification_delivery_preferences (subject_id, quiet_start, quiet_end)
       values ($1, ((now() at time zone 'UTC') - interval '1 hour')::time,
                   ((now() at time zone 'UTC') + interval '1 hour')::time)`,
      [recipient],
    );
    expect(await claim()).toBeUndefined();
    const { rows } = await admin.query(
      `select status, attempts, available_at between now() + interval '55 min'
         and now() + interval '65 min' as deferred from public.notification_deliveries
       where notification_id = $1 and channel = 'email'`,
      [notification],
    );
    expect(rows).toEqual([{ status: 'pending', attempts: 0, deferred: true }]);
  });

  it('backs off retries, fences expired leases, and records exhaustion durably', async () => {
    const notification = await notify('Retry report');
    const first = (await claim())!;
    let last = first;
    for (const [index, delay] of [5, 10, 20, 40, 80].entries()) {
      if (index > 0) {
        await admin.query(
          `update public.notification_deliveries set available_at = now() - interval '1 second' where id = $1`,
          [first.delivery_id],
        );
        last = (await claim())!;
        expect(
          await record(first.delivery_id, first.lease_id, 'accepted', 5),
        ).toBe(false);
      }
      expect(last.delivery_id).toBe(first.delivery_id);
      expect(last.attempts).toBe(index + 1);
      expect(
        await record(last.delivery_id, last.lease_id, 'retryable', delay),
      ).toBe(true);
      expect(await claim()).toBeUndefined();
      const { rows } = await admin.query(
        `select status, reason, attempts, available_at > now() + make_interval(secs => $2 - 1)
         and available_at <= now() + make_interval(secs => $2) as backed_off,
         resolved_at is not null as resolved from public.notification_deliveries
         where notification_id = $1 and channel = 'email'`,
        [notification, delay],
      );
      expect(rows).toEqual([
        index === 4
          ? {
              status: 'failed',
              reason: 'attempts_exhausted',
              attempts: 5,
              backed_off: false,
              resolved: true,
            }
          : {
              status: 'pending',
              reason: 'provider_retryable',
              attempts: index + 1,
              backed_off: true,
              resolved: false,
            },
      ]);
    }
  });

  it('queues one digest on local Monday and summarizes only that subject’s preceding local week', async () => {
    await admin.query(
      `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency)
       values ($1, 'stale@example.test', 'Recipient', 'en', 'US', 'America/New_York', 'YYYY-MM-DD', 1, '1,234.56', 'USD')`,
      [recipient],
    );
    await notify('Before the local week', '2026-03-02T04:59:59Z');
    await notify('First local report', '2026-03-02T05:00:00Z');
    await notify('Last local report', '2026-03-09T03:59:59Z');
    await notify('Next local week', '2026-03-09T04:00:00Z');
    await notify('Peer UTC report', '2026-03-02T00:00:00Z', peer);
    const schedule = async (at: string) =>
      (
        await admin.query<{ count: number }>(
          'select public.prepare_notification_digests($1::timestamptz) as count',
          [at],
        )
      ).rows[0].count;
    expect(await schedule('2026-03-09T03:59:59Z')).toBe(1); // Monday UTC; New York still Sunday.
    expect(await schedule('2026-03-09T04:00:00Z')).toBe(1);
    expect(await schedule('2026-03-09T04:01:00Z')).toBe(0);
    await admin.query(
      `update public.notification_deliveries set available_at = now() + interval '1 day' where channel <> 'digest'`,
    );
    const digests = [(await claim())!, (await claim())!];
    expect(digests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: email,
          title: 'Savia weekly digest · 2026-03-02',
          body: '2 notifications\n- First local report\n- Last local report',
        }),
        expect.objectContaining({
          recipient: 'notification-peer@example.test',
          body: '1 notification\n- Peer UTC report',
        }),
      ]),
    );
    expect(await claim()).toBeUndefined();
  });

  it('uses the 169-hour fall-back week and falls back to UTC for an invalid profile timezone', async () => {
    await admin.query(
      `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency)
       values ($1, 'a@example.test', 'Recipient', 'en', 'US', 'America/New_York', 'YYYY-MM-DD', 1, '1,234.56', 'USD'),
              ($2, 'b@example.test', 'Peer', 'en', 'US', 'Mars/Olympus', 'YYYY-MM-DD', 1, '1,234.56', 'USD')`,
      [recipient, peer],
    );
    await notify('First New York report', '2026-10-26T04:00:00Z');
    await notify('Last New York report', '2026-11-02T04:59:59Z');
    await notify('First UTC report', '2026-10-26T00:00:00Z', peer);
    await notify('Too late for UTC week', '2026-11-02T00:00:00Z', peer);
    await admin.query(
      `select public.prepare_notification_digests('2026-11-02T05:00:00Z')`,
    );
    await admin.query(
      `update public.notification_deliveries set available_at = now() + interval '1 day' where channel <> 'digest'`,
    );
    const digests = [await claim(), await claim()];
    expect(digests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: email,
          body: '2 notifications\n- First New York report\n- Last New York report',
        }),
        expect.objectContaining({
          recipient: 'notification-peer@example.test',
          body: '1 notification\n- First UTC report',
        }),
      ]),
    );
    expect(await claim()).toBeUndefined();
  });

  it('permits worker function execution but denies worker table access and application claims', async () => {
    const privateLookup = (client: TransactionClient) =>
      client.query('select public.notification_verified_email($1)', [
        recipient,
      ]);
    await expect(
      worker.runAsQueueConsumer(privateLookup),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(worker.run(recipient, privateLookup)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      worker.runAsQueueConsumer((client) =>
        client.query('select * from public.notification_deliveries'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      worker.runAsQueueConsumer((client) =>
        client.query('select email from auth.users'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      worker.run(recipient, (client) =>
        client.query('select * from public.claim_notification_delivery(true)'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await claim()).toBeUndefined();
  });
});

function registerRecurringAndAlertTests(
  fixture: () => {
    admin: Pool;
    transaction: PgTransaction;
    adapter: PostgresJobsAdapter;
    queueAdapter: PgmqJobQueueAdapter;
  },
  {
    ownerA,
    ownerB,
    viewerA,
    ws1Id,
    ws2Id,
  }: {
    ownerA: string;
    ownerB: string;
    viewerA: string;
    ws1Id: string;
    ws2Id: string;
  },
): void {
  let admin: Pool;
  let transaction: PgTransaction;
  let adapter: PostgresJobsAdapter;
  let queueAdapter: PgmqJobQueueAdapter;

  beforeAll(() => {
    ({ admin, transaction, adapter, queueAdapter } = fixture());
  });

  it('sweeps due rules once per scheduled timestamp and commits completion with the occurrence', async () => {
    const scheduledAt = '2025-01-31T08:00:00.000123Z';
    const asOf = '2025-02-01T00:00:00.000Z';
    const nextConfirmedAt = '2025-02-28T08:00:00.000000Z';
    const [confirm, remind, later, inactive, viewer] = [
      8301, 8302, 8303, 8304, 8305,
    ].map(id);
    for (const [
      ruleId,
      workspaceId,
      actorId,
      accountId,
      due,
      active,
      behavior,
    ] of [
      [
        confirm,
        ws1Id,
        ownerA,
        id(8201),
        scheduledAt,
        true,
        'confirm_automatically',
      ],
      [remind, ws2Id, ownerB, id(8202), scheduledAt, true, 'remind'],
      [
        later,
        ws1Id,
        ownerA,
        id(8201),
        '2025-02-02T08:00:00.000000Z',
        true,
        'remind',
      ],
      [inactive, ws1Id, ownerA, id(8201), scheduledAt, false, 'remind'],
      [viewer, ws1Id, viewerA, id(8201), scheduledAt, true, 'remind'],
    ] as const) {
      await admin.query(
        `insert into public.recurring_rules
           (id, workspace_id, name, frequency, behavior, account_id, template, active,
            created_by, starts_at, ends_at, next_occurrence_at, anchor_day_of_month)
         values ($1,$2,'Worker rule','monthly',$3,$4,$5,$6,$7,'2024-12-31T08:00:00Z',$9,$8,31)`,
        [
          ruleId,
          workspaceId,
          behavior,
          accountId,
          JSON.stringify({
            type: 'expense',
            accountId,
            amount: { currency: 'USD', amountMinor: '100' },
            status: 'draft',
            occurredAt: '2024-12-31T08:00:00Z',
            description: 'Recurring worker test',
          }),
          active,
          actorId,
          due,
          ruleId === confirm ? nextConfirmedAt : due,
        ],
      );
    }
    const jobs = () =>
      admin.query<{
        id: string;
        workspace_id: string;
        created_by: string;
        status: string;
        result_resource_id: string | null;
        payload: { ruleId: string; scheduledAt: string; asOf: string };
      }>(`select id, workspace_id, created_by, status, result_resource_id, payload from public.jobs
        where type = 'recurring_materialization' order by payload->>'ruleId', payload->>'scheduledAt'`);
    const effects = () =>
      admin.query(
        `select r.active, o.id as occurrence_id, o.transaction_id, t.status, t.created_by
         from public.recurring_rules r
         left join public.recurring_occurrences o on o.rule_id = r.id
         left join public.transactions t on t.id = o.transaction_id
        where r.id = any($1::uuid[]) order by r.id`,
        [[confirm, remind]],
      );
    const preflight = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    vi.stubEnv('SAVIA_WORKER_POLL_INTERVAL_MS', '50');
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    try {
      const sweep = app.get(RecurringJobSweep);
      const counts = await Promise.all([
        sweep.sweep(new Date(asOf)),
        sweep.sweep(new Date(asOf)),
      ]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
      expect(await sweep.sweep(new Date(asOf))).toBe(0);
      const queued = (await jobs()).rows;
      expect(queued).toMatchObject([
        {
          workspace_id: ws1Id,
          created_by: ownerA,
          status: 'queued',
          payload: { ruleId: confirm, asOf, scheduledAt },
        },
        {
          workspace_id: ws2Id,
          created_by: ownerB,
          status: 'queued',
          payload: { ruleId: remind, asOf, scheduledAt },
        },
      ]);

      const messages = await queueAdapter.claim(300, 50);
      const [first, reminder] = queued.map(
        (job) => messages.find((msg) => msg.message.job_id === job.id)!,
      );
      expect(first.message).toMatchObject({
        actor_id: ownerA,
        workspace_id: ws1Id,
      });
      expect(reminder.message).toMatchObject({
        actor_id: ownerB,
        workspace_id: ws2Id,
      });
      const appRunner = app.get(JobRunner);
      vi.spyOn(
        app.get(PostgresJobsAdapter),
        'completeJob',
      ).mockRejectedValueOnce(new Error('Completion unavailable'));
      expect(await appRunner.processMessage(first)).toBe(false);
      expect((await jobs()).rows.map((job) => job.status)).toEqual([
        'processing',
        'queued',
      ]);
      expect((await effects()).rows).toEqual(
        Array.from({ length: 2 }, () => ({
          active: true,
          occurrence_id: null,
          transaction_id: null,
          status: null,
          created_by: null,
        })),
      );
      expect(
        (
          await admin.query(
            `select 1 from public.transactions where description = 'Recurring worker test'`,
          )
        ).rowCount,
      ).toBe(0);
      await queueAdapter.defer(first.msgId, 0);
      const redelivery = (await queueAdapter.claim(300, 50)).find(
        (msg) => msg.msgId === first.msgId,
      )!;
      expect(redelivery.readCt).toBe(2);
      expect(await appRunner.processMessage(redelivery)).toBe(true);
      expect(await appRunner.processMessage(reminder)).toBe(true);
      const completed = (await jobs()).rows;
      expect(completed.map((job) => job.status)).toEqual([
        'completed',
        'completed',
      ]);
      expect((await effects()).rows).toEqual([
        {
          active: true,
          occurrence_id: completed[0].result_resource_id,
          transaction_id: expect.any(String),
          status: 'confirmed',
          created_by: ownerA,
        },
        {
          active: false,
          occurrence_id: completed[1].result_resource_id,
          transaction_id: null,
          status: null,
          created_by: null,
        },
      ]);
      expect(await sweep.sweep(new Date(asOf))).toBe(0);

      await appRunner.start();
      await vi.waitFor(async () => {
        expect(
          (await jobs()).rows.map((job) => [
            job.payload.ruleId,
            job.payload.scheduledAt,
            job.status,
          ]),
        ).toEqual([
          [confirm, scheduledAt, 'completed'],
          [confirm, nextConfirmedAt, 'completed'],
          [remind, scheduledAt, 'completed'],
          [later, '2025-02-02T08:00:00.000000Z', 'completed'],
        ]);
      });
    } finally {
      await app.close();
      preflight.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 10_000);

  it('S5 discovery has no effective execute privilege for API roles', async () => {
    const result = await admin.query(`
      select role, has_function_privilege(role, f.oid, 'EXECUTE') as allowed
      from pg_proc f cross join unnest(array['anon','authenticated','service_role',
        'savia_application','savia_worker']) as role
      where f.oid = 'public.find_due_recurring_occurrences(timestamptz)'::regprocedure
      order by role`);
    console.log('S5 effective discovery ACL', JSON.stringify(result.rows));
    expect(result.rows).toEqual([
      { role: 'anon', allowed: false },
      { role: 'authenticated', allowed: false },
      { role: 'savia_application', allowed: false },
      { role: 'savia_worker', allowed: true },
      { role: 'service_role', allowed: false },
    ]);
  });

  it('S5 worker sees minimal discovery metadata and has no effective table grants', async () => {
    const { rows } = await admin.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'pgmq') and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege('savia_worker', c.oid, 'TRUNCATE,TRIGGER')
          or has_table_privilege('savia_worker', c.oid, 'DELETE')
          or has_any_column_privilege('savia_worker', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`);
    expect(rows).toEqual([]);
    const discovery = await transaction.runAsQueueConsumer((client) =>
      client.query(`
      select * from public.find_due_recurring_occurrences('2024-01-01Z')`),
    );
    expect(discovery.rows).toEqual([]);
  });

  it('S5 does not publish after discovery or book after queueing if the creator loses write access', async () => {
    const creator = viewerA;
    const ruleId = id(8399);
    const starts = '2024-03-08T06:30:00.000Z';
    const scheduledAt = '2024-03-10T06:30:00.000Z';
    const sixDigit = scheduledAt.replace('.000Z', '.000000Z');
    const setRole = (role: string) =>
      admin.query(
        `update public.workspace_memberships
      set role = $1 where workspace_id = $2 and profile_id = $3`,
        [role, ws1Id, creator],
      );
    await setRole('editor');
    await admin.query(
      `insert into public.recurring_rules
      (id, workspace_id, name, frequency, behavior, account_id, template, active,
       created_by, starts_at, ends_at, next_occurrence_at, anchor_day_of_month)
      values ($1,$2,'Revocation probe','daily','confirm_automatically',$3,$4,true,$5,$6,$7,$7,8)`,
      [
        ruleId,
        ws1Id,
        id(8201),
        JSON.stringify({
          type: 'expense',
          accountId: id(8201),
          amount: { currency: 'USD', amountMinor: '100' },
          status: 'draft',
          occurredAt: starts,
          description: 'S5 revocation probe',
        }),
        creator,
        starts,
        scheduledAt,
      ],
    );
    const bootstrap = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    try {
      const sweep = app.get(RecurringJobSweep);
      expect(await sweep.sweep(new Date('2024-03-10T06:29:59.999Z'))).toBe(0);
      const found = await transaction.runAsQueueConsumer((client) =>
        client.query(
          `
        select * from public.find_due_recurring_occurrences($1)`,
          [scheduledAt],
        ),
      );
      expect(found.rows).toEqual([
        { workspaceId: ws1Id, subject: creator, ruleId, scheduledAt: sixDigit },
      ]);
      const revokeAfterDiscovery = new RecurringJobSweep(
        {
          run: transaction.run.bind(transaction),
          runAsQueueConsumer: async (callback, timeout) => {
            const rows = await transaction.runAsQueueConsumer(
              callback,
              timeout,
            );
            await setRole('viewer');
            return rows;
          },
        },
        new PostgresOccurrenceAdapter(),
        adapter,
        5000,
      );
      expect(await revokeAfterDiscovery.sweep(new Date(scheduledAt))).toBe(0);
      await setRole('editor');
      expect(await sweep.sweep(new Date(scheduledAt))).toBe(1);
      const [message] = await queueAdapter.claim(300, 50);
      expect(message.message.actor_id).toBe(creator);
      await admin.query(
        'delete from public.workspace_memberships where workspace_id=$1 and profile_id=$2',
        [ws1Id, creator],
      );
      expect(await app.get(JobRunner).processMessage(message)).toBe(false);
      const { rows } = await admin.query(
        `select j.status, j.error->>'code' as reason,
        (select count(*)::int from public.recurring_occurrences where rule_id=$1) as occurrences,
        (select count(*)::int from public.transactions where description='S5 revocation probe') as transactions
        from public.jobs j where j.payload->>'ruleId'=$1::text`,
        [ruleId],
      );
      console.log('S5 revoked execution', JSON.stringify(rows));
      expect(rows).toMatchObject([
        { status: 'failed', occurrences: 0, transactions: 0 },
      ]);
    } finally {
      await app.close();
      bootstrap.mockRestore();
      await admin.query(
        `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
         values ($1,$2,'viewer','active') on conflict (workspace_id, profile_id)
         do update set role = excluded.role, status = excluded.status`,
        [ws1Id, creator],
      );
    }
  }, 10000);
  it('S5 does not book after an in-flight creator removal commits', async () => {
    const ruleId = id(8400);
    const creator = ownerB;
    const membership = await admin.query(
      `insert into public.workspace_memberships
      (workspace_id,profile_id,role,status) values ($1,$2,'editor','active') returning id`,
      [ws1Id, creator],
    );
    const scheduled = '2024-02-29T23:30:00.000Z';
    await admin.query(
      `insert into public.recurring_rules
      (id,workspace_id,name,frequency,behavior,account_id,template,active,created_by,
        starts_at,ends_at,next_occurrence_at,anchor_day_of_month)
      values ($1,$2,'Commit race','monthly','confirm_automatically',$3,$4,true,$5,
        '2024-01-31T23:30:00Z',$6,$6,31)`,
      [
        ruleId,
        ws1Id,
        id(8201),
        JSON.stringify({
          type: 'expense',
          accountId: id(8201),
          amount: { currency: 'USD', amountMinor: '100' },
          status: 'draft',
          occurredAt: '2024-01-31T23:30:00Z',
          description: 'S5 commit race',
        }),
        creator,
        scheduled,
      ],
    );
    const bootstrap = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    const memberStore = new PostgresWorkspaceMemberAdapter();
    try {
      expect(await app.get(RecurringJobSweep).sweep(new Date(scheduled))).toBe(
        1,
      );
      const [message] = await queueAdapter.claim(300, 50);
      const writer = app.get(PostgresJobsAdapter);
      const original = writer.completeJob.bind(writer);
      let removalCommittedBeforeBooking = false;
      vi.spyOn(writer, 'completeJob').mockImplementationOnce(
        async (...args) => {
          const result = await original(...args);
          const removal = await transaction
            .run(ownerA, async (client) => {
              await client.query(
                "select set_config('lock_timeout', '100ms', true)",
              );
              const count = await memberStore.deleteMember(
                client,
                ws1Id,
                membership.rows[0].id,
              );
              await memberStore.enforceDeferredConstraints(client);
              return count;
            })
            .catch((e: unknown) => {
              if ((e as { cause?: { code?: string } }).cause?.code === '55P03')
                return 0;
              throw e;
            });
          removalCommittedBeforeBooking = removal === 1;
          expect(
            (
              await admin.query(
                `select 1 from public.transactions where description='S5 commit race'`,
              )
            ).rowCount,
          ).toBe(0);
          return result;
        },
      );
      const processed = await app.get(JobRunner).processMessage(message);
      const { rows } = await admin.query(
        `select
        (select count(*)::int from public.recurring_occurrences where rule_id=$1) as occurrences,
        (select count(*)::int from public.transactions where description='S5 commit race') as bookings`,
        [ruleId],
      );
      console.log(
        'S5 commit race',
        JSON.stringify({
          removalCommittedBeforeBooking,
          processed,
          ...rows[0],
        }),
      );
      if (removalCommittedBeforeBooking)
        expect(rows).toEqual([{ occurrences: 0, bookings: 0 }]);
      else expect(rows).toEqual([{ occurrences: 1, bookings: 1 }]);
    } finally {
      await app.close();
      bootstrap.mockRestore();
    }
  }, 10000);
  it('S5 rechecks a non-key demotion that wins the row lock', async () => {
    const creator = ownerB;
    const ruleId = id(8401);
    const scheduledAt = '2024-01-01T00:00:00.000Z';
    await admin.query(
      `insert into public.workspace_memberships
      (workspace_id,profile_id,role,status) values ($1,$2,'editor','active')
      on conflict (workspace_id,profile_id) do update set role='editor', status='active'`,
      [ws1Id, creator],
    );
    await admin.query(
      `insert into public.recurring_rules
      (id,workspace_id,name,frequency,behavior,account_id,template,active,created_by,
       starts_at,ends_at,next_occurrence_at,anchor_day_of_month)
      values ($1,$2,'Revocation-first probe','daily','remind',$3,$4,true,$5,$6,$6,$6,1)`,
      [
        ruleId,
        ws1Id,
        id(8201),
        JSON.stringify({
          type: 'expense',
          accountId: id(8201),
          amount: { amountMinor: '2', currency: 'USD' },
          status: 'draft',
          occurredAt: scheduledAt,
        }),
        creator,
        scheduledAt,
      ],
    );
    const acl = await admin.query(`select role, has_function_privilege(role,
      'public.lock_recurring_creator_membership(uuid)', 'EXECUTE') as allowed
      from unnest(array['anon','authenticated','savia_application','savia_worker','service_role']) role
      order by role`);
    expect(acl.rows.map(({ allowed }) => allowed)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    const holder = await admin.connect();
    let locking: Promise<unknown> | undefined;
    try {
      await holder.query('begin');
      const {
        rows: [{ pid: holderPid }],
      } = await holder.query('select pg_backend_pid() pid');
      await holder.query(
        `update public.workspace_memberships set role='viewer'
        where workspace_id=$1 and profile_id=$2`,
        [ws1Id, creator],
      );
      const connected = Promise.withResolvers<number>();
      locking = transaction.run(creator, async (client) => {
        const {
          rows: [{ pid }],
        } = await client.query<{ pid: number }>('select pg_backend_pid() pid');
        connected.resolve(pid);
        return new PostgresOccurrenceAdapter().lockDue(client, {
          workspaceId: ws1Id,
          subject: creator,
          ruleId,
          scheduledAt,
          asOf: scheduledAt,
        });
      });
      void locking.catch(() => undefined);
      const pid = await connected.promise;
      await vi.waitFor(
        async () => {
          const { rows } = await admin.query(
            'select $1::int = any(pg_blocking_pids($2)) blocked',
            [holderPid, pid],
          );
          expect(rows[0].blocked).toBe(true);
        },
        { timeout: 1000 },
      );
      await holder.query('commit');
      expect(await locking).toBeUndefined();
      console.log(
        'S5 demotion-first probe: waiter observed, denied after commit; helper ACL application-only',
      );
    } finally {
      await holder.query('rollback');
      holder.release();
      await locking?.catch(() => undefined);
    }
  });

  // Reviewer regressions for B6 (verify task mwr1jzkz). Insert inside the outer describe of
  // test/jobs/job-worker.integration-spec.ts, before its final "});".
  const b6Ledger = () =>
    new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      new PostgresIdempotencyAdapter(),
    );
  const b6Charge = (
    description: string,
    days: number,
    amountMinor: string,
    payeeId?: string,
    categoryId?: string,
  ) =>
    b6Ledger().create(
      ownerA,
      ws1Id,
      {
        type: 'expense',
        accountId: id(8201),
        amount: { currency: 'USD', amountMinor },
        occurredAt: new Date(Date.now() + days * 86_400_000).toISOString(),
        description,
        status: 'confirmed',
        payeeId,
        categoryId,
      },
      randomUUID(),
    );
  const b6Sweep = async () => {
    const preflight = vi
      .spyOn(tesseractAdapter, 'runOcrStartupPreflight')
      .mockResolvedValue(undefined);
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    try {
      const runner = app.get(JobRunner);
      await runner.start();
      await vi.waitFor(() => expect(runner.activeJobsCount).toBe(0));
      await runner.stop();
    } finally {
      await app.close();
      preflight.mockRestore();
    }
  };

  it('S6 alerts an active creator who retained read access after demotion', async () => {
    const category = id(9001);
    const budget = id(9002);
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by)
      values ($1,$2,'Demotion category','expense',$3)`,
      [category, ws1Id, ownerA],
    );
    await admin.query(
      `insert into public.budgets (id, workspace_id, name, method, period_start, period_end, currency, created_by)
      values ($1,$2,'Demotion budget','envelope',(now() at time zone 'UTC')::date-1,(now() at time zone 'UTC')::date+1,'USD',$3)`,
      [budget, ws1Id, ownerA],
    );
    await admin.query(
      `insert into public.budget_allocations (workspace_id,budget_id,category_id,planned_minor)
      values ($1,$2,$3,1000)`,
      [ws1Id, budget, category],
    );
    expect(
      (await b6Charge('Demotion expense', 0, '1000', undefined, category)).kind,
    ).toBe('created');
    await admin.query(
      `update public.workspace_memberships set role='owner' where workspace_id=$1 and profile_id=$2`,
      [ws1Id, viewerA],
    );
    try {
      await admin.query(
        `update public.workspace_memberships set role='viewer' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, ownerA],
      );
      expect(
        (
          await transaction.runRead(ownerA, (client) =>
            client.query(`select id from public.budgets where id=$1`, [budget]),
          )
        ).rows,
      ).toEqual([{ id: budget }]);
      await b6Sweep();
      await b6Sweep();
      const rows = (
        await admin.query(
          `select subject_id, type from public.notifications where resource_id=$1 order by type`,
          [budget],
        )
      ).rows;
      expect(rows).toEqual([
        { subject_id: ownerA, type: 'budget_threshold_100' },
        { subject_id: ownerA, type: 'budget_threshold_80' },
      ]);
    } finally {
      await admin.query(
        `update public.workspace_memberships set role='owner' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, ownerA],
      );
      await admin.query(
        `update public.workspace_memberships set role='viewer' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, viewerA],
      );
    }
  });

  it('S6 does not merge distinct one-off purchases from a known payee', async () => {
    const payee = id(9003);
    await admin.query(
      `insert into public.payees (id,workspace_id,name,created_by)
      values ($1,$2,'Office Supply Store',$3)`,
      [payee, ws1Id, ownerA],
    );
    for (const [i, item] of ['Printer ink', 'USB cable', 'Mouse pad'].entries())
      expect((await b6Charge(item, -16 + 7 * i, '1999', payee)).kind).toBe(
        'created',
      );
    await b6Sweep();
    expect(
      (
        await admin.query(
          `select status, frequency from public.subscriptions where workspace_id=$1 and payee_name='Office Supply Store'`,
          [ws1Id],
        )
      ).rows,
    ).toEqual([]);
  });

  it('S6 alerts on a 25% increase in an already established monthly series', async () => {
    for (const day of [-92, -62, -32])
      expect((await b6Charge('Cloud archive', day, '1000')).kind).toBe(
        'created',
      );
    await b6Sweep();
    const rows = async () =>
      (
        await admin.query(
          `select id, current_amount_minor from public.subscriptions where workspace_id=$1 and payee_name='Cloud archive'`,
          [ws1Id],
        )
      ).rows;
    expect((await rows()).map((row) => row.current_amount_minor)).toEqual([
      '1000',
    ]);
    const subscriptionId = (await rows())[0].id;
    expect((await b6Charge('Cloud archive', -2, '1250')).kind).toBe('created');
    await b6Sweep();
    await b6Sweep();
    expect({
      rows: await rows(),
      alerts: (
        await admin.query(
          `select title from public.notifications where workspace_id=$1 and title like 'Subscription “Cloud archive”%'`,
          [ws1Id],
        )
      ).rows,
    }).toEqual({
      rows: [{ id: subscriptionId, current_amount_minor: '1250' }],
      alerts: [{ title: 'Subscription “Cloud archive” increased by 25%' }],
    });
  });

  it('S6 does not re-emit the same subscription increase when the workspace actor changes', async () => {
    await admin.query(
      `insert into public.subscriptions
      (workspace_id, payee_name, current_amount_minor, current_currency, previous_amount_minor, previous_currency, frequency, status, created_by)
      values ($1,'Owner rotation',1100,'USD',1000,'USD','monthly','confirmed',$2)`,
      [ws1Id, ownerA],
    );
    const alerts = async () =>
      (
        await admin.query(
          `select resource_id, subject_id from public.notifications
      where workspace_id=$1 and title = 'Subscription “Owner rotation” increased by 10%' order by subject_id`,
          [ws1Id],
        )
      ).rows;
    await b6Sweep();
    const first = await alerts();
    expect(first).toEqual([
      { resource_id: expect.any(String), subject_id: ownerA },
    ]);
    await admin.query(
      `update public.workspace_memberships set role='owner' where workspace_id=$1 and profile_id=$2`,
      [ws1Id, viewerA],
    );
    try {
      await admin.query(
        `update public.workspace_memberships set role='editor' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, ownerA],
      );
      await b6Sweep();
      expect(await alerts()).toEqual(first);
    } finally {
      await admin.query(
        `update public.workspace_memberships set role='owner' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, ownerA],
      );
      await admin.query(
        `update public.workspace_memberships set role='viewer' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, viewerA],
      );
    }
  });

  it('S6 alerts once when a tracked series changes frequency', async () => {
    for (const day of [-75, -45, -15])
      expect((await b6Charge('Change cadence', day, '1000')).kind).toBe(
        'created',
      );
    const subscriptions = new RecurringService(
      transaction,
      new PostgresRecurringAdapter(),
      new PostgresIdempotencyAdapter(),
    );
    const query = createSubscriptionListQuery({
      workspaceId: ws1Id,
      statusParam: 'detected',
    });
    const candidate = async () => {
      const listed = await subscriptions.listSubscriptions(ownerA, query);
      if (listed.kind !== 'ok') throw new Error('Could not list candidates');
      return listed.page.items.find(
        ({ payeeName }) => payeeName === 'Change cadence',
      );
    };
    const notifications = new NotificationService(
      transaction,
      new PostgresNotificationAdapter(),
      new PostgresIdempotencyAdapter(),
    );
    const alerts = async () =>
      (
        await notifications.listNotifications(ownerA, {
          subject: ownerA,
          limit: 50,
          unreadOnly: false,
        })
      ).page.items.filter(({ title }) =>
        title.startsWith('Subscription “Change cadence”'),
      );
    await b6Sweep();
    const initial = await candidate();
    expect(initial).toMatchObject({ frequency: 'monthly', status: 'detected' });
    expect(await alerts()).toEqual([]);
    for (const day of [-8, -1])
      expect((await b6Charge('Change cadence', day, '1000')).kind).toBe(
        'created',
      );
    await b6Sweep();
    expect(await candidate()).toMatchObject({
      id: initial?.id,
      frequency: 'weekly',
      status: 'detected',
    });
    const emitted = await alerts();
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'subscription_frequency_change',
        title: 'Subscription “Change cadence” changed from monthly to weekly',
        read: false,
        body: null,
        actionUrl: null,
      }),
    ]);
    await b6Sweep();
    expect(await alerts()).toEqual(emitted);
  });

  it('S6 preserves populated 0017 subscription IDs and does not replay their price alerts after the 0018 upgrade', async () => {
    const payee = id(9050);
    const detected = id(9051);
    const legacy = id(9052);
    const detectedName = 'Upgrade detected';
    const legacyName = 'Upgrade legacy';
    const controlName = 'Upgrade control';
    const priceTitle = (name: string) =>
      `Subscription “${name}” increased by 10%`;
    await admin.query(
      `insert into public.payees (id, workspace_id, name, created_by) values ($1, $2, $3, $4)`,
      [payee, ws1Id, detectedName, ownerA],
    );
    for (const day of [-62, -32]) {
      expect((await b6Charge('Monthly archive', day, '1000', payee)).kind).toBe(
        'created',
      );
    }
    const newest = await b6Charge('MONTHLY   ARCHIVE', -2, '1100', payee);
    if (newest.kind !== 'created')
      throw new Error('Could not create the 0017 observation');
    const observation = newest.transaction.id;

    // 0017 grouped known payees without a description and used the raw charge ID for its alert.
    await admin.query(
      `insert into public.subscriptions
         (id, workspace_id, created_by, status, detection_key, detection_observed_at, detection_observation_id,
          payee_name, current_currency, current_amount_minor, previous_currency, previous_amount_minor, frequency, next_expected_at)
       select $1, t.workspace_id, $2, 'detected',
         encode(sha256(convert_to(jsonb_build_array(t.account_id, t.currency, t.payee_id, null)::text, 'UTF8')), 'hex'),
         t.occurred_at, t.id, $3, t.currency, t.amount_minor, t.currency, 1000, 'monthly', t.occurred_at + interval '1 month'
       from public.transactions t where t.id = $4`,
      [detected, ownerA, detectedName, observation],
    );
    await admin.query(
      `insert into public.subscriptions
         (id, workspace_id, payee_name, current_amount_minor, current_currency, previous_amount_minor,
          previous_currency, frequency, status, created_by)
       values ($1,$2,$3,1100,'USD',1000,'USD','monthly','confirmed',$4),
              ($5,$2,$6,1100,'USD',1000,'USD','monthly','confirmed',$4)`,
      [legacy, ws1Id, legacyName, ownerA, id(9053), controlName],
    );
    // A legacy subscription has no observation metadata and uses the 0017 amount-pair UUID.
    await admin.query(
      `insert into public.notifications (workspace_id, subject_id, type, resource_id, title)
       values ($1,$2,'subscription_price_increase',$3,$4),
              ($1,$2,'subscription_price_increase',md5(jsonb_build_array($5::uuid, 1100, 'USD', 1000, 'USD')::text)::uuid,$6)`,
      [
        ws1Id,
        ownerA,
        observation,
        priceTitle(detectedName),
        legacy,
        priceTitle(legacyName),
      ],
    );
    const history = async () =>
      (
        await admin.query(
          `select id, subject_id, resource_id, title from public.notifications
       where workspace_id = $1 and type = 'subscription_price_increase' and title = any($2::text[]) order by title, id`,
          [ws1Id, [priceTitle(detectedName), priceTitle(legacyName)]],
        )
      ).rows;
    const original = await history();
    expect(original).toEqual(
      [detectedName, legacyName].map((name) =>
        expect.objectContaining({
          subject_id: ownerA,
          title: priceTitle(name),
        }),
      ),
    );

    // The disposable runner installs the whole schema before fixtures. Run the
    // two data statements verbatim on the seeded 0017 rows, without replaying DDL.
    const migration = readFileSync(
      'supabase/migrations/202609170018_b6_alert_recipients.sql',
      'utf8',
    );
    const backfill =
      migration.match(
        /^(?:update public\.subscriptions s|insert into public\.subscription_notification_events \().*?;$/gms,
      ) ?? [];
    expect(backfill).toHaveLength(2);
    await admin.query(backfill.join('\n'));

    await admin.query(
      `update public.workspace_memberships set role='owner' where workspace_id=$1 and profile_id=$2`,
      [ws1Id, viewerA],
    );
    try {
      await admin.query(
        `update public.workspace_memberships set role='editor' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, ownerA],
      );
      await b6Sweep();
      // The same sweep must deliver an unseen increase to the new recipient.
      expect(
        (
          await admin.query(
            `select subject_id from public.notifications where workspace_id=$1 and title=$2`,
            [ws1Id, priceTitle(controlName)],
          )
        ).rows,
      ).toEqual([{ subject_id: viewerA }]);
      expect({
        subscriptions: (
          await admin.query(
            `select id, status from public.subscriptions where workspace_id=$1 and payee_name = any($2::text[]) order by payee_name, id`,
            [ws1Id, [detectedName, legacyName]],
          )
        ).rows,
        alerts: await history(),
      }).toEqual({
        subscriptions: [
          { id: detected, status: 'detected' },
          { id: legacy, status: 'confirmed' },
        ],
        alerts: original,
      });
    } finally {
      await admin.query(
        `update public.workspace_memberships set role='owner' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, ownerA],
      );
      await admin.query(
        `update public.workspace_memberships set role='viewer' where workspace_id=$1 and profile_id=$2`,
        [ws1Id, viewerA],
      );
    }
  });
}
