// Migrations under test: 202609040003_forecasts.sql, 202609100016_job_queue.sql, 202609100018_job_dead_letter_audit.sql
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { FORECAST_METHOD } from '../../src/forecasts/forecast.port.js';
import { ForecastService } from '../../src/forecasts/forecast.service.js';
import { PostgresForecastAdapter } from '../../src/forecasts/postgres-forecast.adapter.js';
import {
  JOB_HANDLERS,
  type JobHandler,
} from '../../src/platform/job-handler.port.js';
import { JobRunner } from '../../src/platform/job-runner.js';
import {
  JOB_WRITER,
  type JobWriter,
} from '../../src/platform/job-writer.port.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { WorkerModule } from '../../src/worker.module.js';

const FIXED_NOW = new Date('2026-09-04T12:00:00.000Z');
let forecastClock: () => Date = () => new Date();

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for integration tests.');
}

async function seedRelativeForecastFixture(
  admin: Pool,
  input: {
    readonly now: Date;
    readonly workspaceId: string;
    readonly ownerId: string;
    readonly checkingId: string;
    readonly savingsId: string;
    readonly eurId: string;
  },
): Promise<void> {
  const curYear = input.now.getUTCFullYear();
  const curMonth = input.now.getUTCMonth();
  const asOfIso = input.now.toISOString();

  await admin.query(
    `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
      ($1, 'Pinned Forecast Workspace', 'shared', 'USD', null, $2)`,
    [input.workspaceId, input.ownerId],
  );
  await admin.query(
    `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
      ($1, $2, 'owner', 'active')`,
    [input.workspaceId, input.ownerId],
  );
  await admin.query(
    `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by) values
      ($1, 'EUR', 'USD', 1.080000000000000000, $3::timestamptz, 'test', $2),
      ($1, 'USD', 'EUR', 0.920000000000000000, $3::timestamptz, 'test', $2)`,
    [input.workspaceId, input.ownerId, asOfIso],
  );
  await admin.query(
    `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by) values
      ($1, $2, 'Pinned Checking', 'checking', 'USD', 'active', null, $3),
      ($4, $2, 'Pinned Savings', 'savings', 'USD', 'active', null, $3),
      ($5, $2, 'Pinned EUR', 'checking', 'EUR', 'active', null, $3)`,
    [
      input.checkingId,
      input.workspaceId,
      input.ownerId,
      input.savingsId,
      input.eurId,
    ],
  );

  const seedAccountBalance = async (
    acctId: string,
    amountMinor: number,
    currency: string,
  ) => {
    const txnId = randomUUID();
    const thirteenMonthsAgo = new Date(
      Date.UTC(curYear, curMonth - 13, 1, 0, 0, 0, 0),
    ).toISOString();
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'income', 'confirmed', $4, $5, $6::timestamptz, $7)`,
      [
        txnId,
        input.workspaceId,
        acctId,
        amountMinor,
        currency,
        thirteenMonthsAgo,
        input.ownerId,
      ],
    );
    await admin.query(
      `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
        ($1, $2, $3, $4, 'account', $5, $6, 'confirmed', $7::timestamptz),
        ($8, $2, $3, null, 'external', $9, $6, 'confirmed', $7::timestamptz)`,
      [
        randomUUID(),
        input.workspaceId,
        txnId,
        acctId,
        amountMinor,
        currency,
        thirteenMonthsAgo,
        randomUUID(),
        -amountMinor,
      ],
    );
  };

  await seedAccountBalance(input.checkingId, 1000000, 'USD');
  await seedAccountBalance(input.savingsId, 500000, 'USD');
  await seedAccountBalance(input.eurId, 100000, 'EUR');

  const monthMinus2 = new Date(
    Date.UTC(curYear, curMonth - 2, 15, 12, 0, 0, 0),
  ).toISOString();
  const monthMinus1 = new Date(
    Date.UTC(curYear, curMonth - 1, 15, 12, 0, 0, 0),
  ).toISOString();
  const month0 = asOfIso;
  const monthMinus5 = new Date(
    Date.UTC(curYear, curMonth - 5, 15, 12, 0, 0, 0),
  ).toISOString();

  const insertFlow = async (
    type: 'income' | 'expense',
    amountMinor: number,
    postingAccountMinor: number,
    occurredAt: string,
  ) => {
    const txnId = randomUUID();
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, $4, 'confirmed', $5, 'USD', $6::timestamptz, $7)`,
      [
        txnId,
        input.workspaceId,
        input.checkingId,
        type,
        amountMinor,
        occurredAt,
        input.ownerId,
      ],
    );
    await admin.query(
      `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
        ($1, $2, $3, $4, 'account', $5, 'USD', 'confirmed', $6::timestamptz),
        ($7, $2, $3, null, 'external', $8, 'USD', 'confirmed', $6::timestamptz)`,
      [
        randomUUID(),
        input.workspaceId,
        txnId,
        input.checkingId,
        postingAccountMinor,
        occurredAt,
        randomUUID(),
        -postingAccountMinor,
      ],
    );
  };

  await insertFlow('income', 300000, 300000, monthMinus2);
  await insertFlow('expense', 100000, -100000, monthMinus1);
  await insertFlow('income', 400000, 400000, month0);

  const txnDisallowedId = randomUUID();
  await admin.query(
    `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
     values ($1, $2, $3, 'income', 'confirmed', 50000000, 'USD', $4::timestamptz, $5)`,
    [
      txnDisallowedId,
      input.workspaceId,
      input.checkingId,
      monthMinus5,
      input.ownerId,
    ],
  );
  await admin.query(
    `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
      ($1, $2, $3, $4, 'account', 50000000, 'USD', 'confirmed', $5::timestamptz),
      ($6, $2, $3, null, 'external', -50000000, 'USD', 'pending', $5::timestamptz)`,
    [
      randomUUID(),
      input.workspaceId,
      txnDisallowedId,
      input.checkingId,
      monthMinus5,
      randomUUID(),
    ],
  );
}

describe('Forecasts integration suite against disposable PostgreSQL', () => {
  let admin: Pool;
  let application: NestFastifyApplication;
  let workerApp: INestApplicationContext;
  let runner: JobRunner;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';
  const nonMemberId = '55555555-0000-4000-8000-000000000001';
  const dualMemberId = '66666666-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';
  const workspacePinnedId = 'aaaaaaaa-0000-4000-8000-000000000003';

  const acctCheckingId = 'cccccccc-0000-4000-8000-000000000001';
  const acctSavingsId = 'cccccccc-0000-4000-8000-000000000002';
  const acctEurId = 'cccccccc-0000-4000-8000-000000000003';
  const acctClosedId = 'cccccccc-0000-4000-8000-000000000004';
  const acctWs2Id = 'cccccccc-0000-4000-8000-000000000005';
  const pinnedCheckingId = 'dddddddd-0000-4000-8000-000000000001';
  const pinnedSavingsId = 'dddddddd-0000-4000-8000-000000000002';
  const pinnedEurId = 'dddddddd-0000-4000-8000-000000000003';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    // Seed test users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'forecasts-owner@example.test'),
        ($2, 'forecasts-editor@example.test'),
        ($3, 'forecasts-viewer@example.test'),
        ($4, 'forecasts-other@example.test'),
        ($5, 'forecasts-nonmember@example.test'),
        ($6, 'forecasts-dual@example.test')`,
      [ownerId, editorId, viewerId, otherOwnerId, nonMemberId, dualMemberId],
    );

    for (const [userId, email, name] of [
      [ownerId, 'forecasts-owner@example.test', 'Forecasts Owner'],
      [editorId, 'forecasts-editor@example.test', 'Forecasts Editor'],
      [viewerId, 'forecasts-viewer@example.test', 'Forecasts Viewer'],
      [otherOwnerId, 'forecasts-other@example.test', 'Forecasts Other Owner'],
      [nonMemberId, 'forecasts-nonmember@example.test', 'Forecasts Non Member'],
      [dualMemberId, 'forecasts-dual@example.test', 'Forecasts Dual Member'],
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

    // Seed workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Workspace 2', 'shared', 'USD', null, $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // Seed memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'editor', 'active'),
        ($1, $4, 'viewer', 'active'),
        ($5, $6, 'owner', 'active'),
        ($1, $7, 'editor', 'active'),
        ($5, $7, 'editor', 'active')`,
      [
        workspace1Id,
        ownerId,
        editorId,
        viewerId,
        workspace2Id,
        otherOwnerId,
        dualMemberId,
      ],
    );

    // Exchange rates: EUR -> USD and USD -> EUR in workspace 1
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by) values
        ($1, 'EUR', 'USD', 1.080000000000000000, now(), 'test', $2),
        ($1, 'USD', 'EUR', 0.920000000000000000, now(), 'test', $2)`,
      [workspace1Id, ownerId],
    );

    // Seed accounts in workspace 1 and workspace 2
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by) values
        ($1, $2, 'Checking Account', 'checking', 'USD', 'active', null, $3),
        ($4, $2, 'Savings Account', 'savings', 'USD', 'active', null, $3),
        ($5, $2, 'EUR Account', 'checking', 'EUR', 'active', null, $3),
        ($6, $2, 'Closed Account', 'checking', 'USD', 'closed', now(), $3),
        ($7, $8, 'WS2 Account', 'checking', 'USD', 'active', null, $9)`,
      [
        acctCheckingId,
        workspace1Id,
        ownerId,
        acctSavingsId,
        acctEurId,
        acctClosedId,
        acctWs2Id,
        workspace2Id,
        otherOwnerId,
      ],
    );

    const now = new Date();
    const curYear = now.getUTCFullYear();
    const curMonth = now.getUTCMonth();

    // Seed initial account balances via confirmed ledger postings (13 months ago to not pollute history window)
    // Checking: 10,000.00 USD (1,000,000 minor)
    // Savings: 5,000.00 USD (500,000 minor)
    // EUR: 1,000.00 EUR (100,000 minor EUR -> 108,000 minor USD at 1.08)
    // Closed: 2,000.00 USD (200,000 minor) - should contribute zero to open balance!
    const seedAccountBalance = async (
      acctId: string,
      amountMinor: number,
      currency: string,
    ) => {
      const txnId = randomUUID();
      const thirteenMonthsAgo = new Date(
        Date.UTC(curYear, curMonth - 13, 1, 0, 0, 0, 0),
      ).toISOString();
      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'income', 'confirmed', $4, $5, $6::timestamptz, $7)`,
        [
          txnId,
          workspace1Id,
          acctId,
          amountMinor,
          currency,
          thirteenMonthsAgo,
          ownerId,
        ],
      );
      await admin.query(
        `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
          ($1, $2, $3, $4, 'account', $5, $6, 'confirmed', $7::timestamptz),
          ($8, $2, $3, null, 'external', $9, $6, 'confirmed', $7::timestamptz)`,
        [
          randomUUID(),
          workspace1Id,
          txnId,
          acctId,
          amountMinor,
          currency,
          thirteenMonthsAgo,
          randomUUID(),
          -amountMinor,
        ],
      );
    };

    await seedAccountBalance(acctCheckingId, 1000000, 'USD');
    await seedAccountBalance(acctSavingsId, 500000, 'USD');
    await seedAccountBalance(acctEurId, 100000, 'EUR');
    await seedAccountBalance(acctClosedId, 200000, 'USD');

    // Seed transactions for history window:
    // Window is 12 monthly buckets: [currentMonth - 11, currentMonth]
    // We seed flow rows in exactly 3 distinct months:
    // - Month -3: 3,000.00 USD income
    // - Month -2: 1,000.00 USD expense
    // - Month -1: 4,000.00 USD income
    // We also seed a transaction in Month -5 that has one confirmed posting AND one pending posting.
    // Due to the negative `not exists` predicate, Month -5 MUST BE EXCLUDED!
    const monthMinus2 = new Date(
      Date.UTC(curYear, curMonth - 2, 15, 12, 0, 0, 0),
    ).toISOString();
    const monthMinus1 = new Date(
      Date.UTC(curYear, curMonth - 1, 15, 12, 0, 0, 0),
    ).toISOString();
    const month0 = now.toISOString();
    const monthMinus5 = new Date(
      Date.UTC(curYear, curMonth - 5, 15, 12, 0, 0, 0),
    ).toISOString();

    const txn1Id = randomUUID();
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'income', 'confirmed', 300000, 'USD', $4::timestamptz, $5)`,
      [txn1Id, workspace1Id, acctCheckingId, monthMinus2, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
        ($1, $2, $3, $4, 'account', 300000, 'USD', 'confirmed', $5::timestamptz),
        ($6, $2, $3, null, 'external', -300000, 'USD', 'confirmed', $5::timestamptz)`,
      [
        randomUUID(),
        workspace1Id,
        txn1Id,
        acctCheckingId,
        monthMinus2,
        randomUUID(),
      ],
    );

    const txn2Id = randomUUID();
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'expense', 'confirmed', 100000, 'USD', $4::timestamptz, $5)`,
      [txn2Id, workspace1Id, acctCheckingId, monthMinus1, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
        ($1, $2, $3, $4, 'account', -100000, 'USD', 'confirmed', $5::timestamptz),
        ($6, $2, $3, null, 'external', 100000, 'USD', 'confirmed', $5::timestamptz)`,
      [
        randomUUID(),
        workspace1Id,
        txn2Id,
        acctCheckingId,
        monthMinus1,
        randomUUID(),
      ],
    );

    const txn3Id = randomUUID();
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'income', 'confirmed', 400000, 'USD', $4::timestamptz, $5)`,
      [txn3Id, workspace1Id, acctCheckingId, month0, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
        ($1, $2, $3, $4, 'account', 400000, 'USD', 'confirmed', $5::timestamptz),
        ($6, $2, $3, null, 'external', -400000, 'USD', 'confirmed', $5::timestamptz)`,
      [
        randomUUID(),
        workspace1Id,
        txn3Id,
        acctCheckingId,
        month0,
        randomUUID(),
      ],
    );

    // Disallowed posting sibling transaction in Month -5:
    // status is confirmed, leg 1 is confirmed, but leg 2 is pending!
    const txnDisallowedId = randomUUID();
    await admin.query(
      `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'income', 'confirmed', 50000000, 'USD', $4::timestamptz, $5)`,
      [txnDisallowedId, workspace1Id, acctCheckingId, monthMinus5, ownerId],
    );
    await admin.query(
      `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
        ($1, $2, $3, $4, 'account', 50000000, 'USD', 'confirmed', $5::timestamptz),
        ($6, $2, $3, null, 'external', -50000000, 'USD', 'pending', $5::timestamptz)`,
      [
        randomUUID(),
        workspace1Id,
        txnDisallowedId,
        acctCheckingId,
        monthMinus5,
        randomUUID(),
      ],
    );

    await seedRelativeForecastFixture(admin, {
      now: FIXED_NOW,
      workspaceId: workspacePinnedId,
      ownerId,
      checkingId: pinnedCheckingId,
      savingsId: pinnedSavingsId,
      eurId: pinnedEurId,
    });

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
          throw new Error('token rejected');
        },
      })
      .overrideProvider(ForecastService)
      .useFactory({
        factory: (
          tx: PgTransaction,
          store: PostgresForecastAdapter,
          idempotency: PostgresIdempotencyAdapter,
          jobs: JobWriter,
        ) =>
          new ForecastService(tx, store, idempotency, jobs, () =>
            forecastClock(),
          ),
        inject: [
          PgTransaction,
          PostgresForecastAdapter,
          PostgresIdempotencyAdapter,
          JOB_WRITER,
        ],
      })
      .compile();

    application = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(application);
    await application.init();
    await application.getHttpAdapter().getInstance().ready();

    workerApp = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    runner = workerApp.get(JobRunner);
  });

  afterAll(async () => {
    if (workerApp) {
      await workerApp.close();
    }
    if (application) {
      await application.close();
    }
    if (admin) {
      await admin.end();
    }
  });

  async function drainUntilTerminal(jobId: string): Promise<{
    status: string;
    result_resource_id: string | null;
    error: Record<string, unknown> | null;
  }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const row = await admin.query<{
        status: string;
        result_resource_id: string | null;
        error: Record<string, unknown> | null;
      }>(
        `select status,
                result_resource_id::text as result_resource_id,
                error
           from public.jobs
          where id = $1::uuid`,
        [jobId],
      );
      const job = row.rows[0];
      if (
        job &&
        ['completed', 'failed', 'dead_letter', 'cancelled'].includes(job.status)
      ) {
        return job;
      }
      await runner.drainOnce();
    }
    throw new Error(`Job ${jobId} did not reach a terminal status`);
  }

  describe('Database schema, RLS, and constraints (202609040003_forecasts.sql)', () => {
    it('verifies forecasts table has forced RLS and named constraints', async () => {
      const rlsRes = await admin.query<{ rls: boolean; force: boolean }>(
        `select relrowsecurity as rls, relforcerowsecurity as force
         from pg_class where relname = 'forecasts' and relnamespace = 'public'::regnamespace`,
      );
      expect(rlsRes.rows[0]?.rls).toBe(true);
      expect(rlsRes.rows[0]?.force).toBe(true);

      const constraintsRes = await admin.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid = 'public.forecasts'::regclass`,
      );
      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toEqual(
        expect.arrayContaining([
          'forecasts_workspace_id_id_key',
          'forecasts_status_check',
          'forecasts_confidence_check',
          'forecasts_horizon_days_range_check',
          'forecasts_assumptions_is_array_check',
          'forecasts_series_is_array_check',
          'forecasts_job_workspace_fkey',
        ]),
      );

      const indexRes = await admin.query<{ indexname: string }>(
        `select indexname from pg_indexes
         where tablename = 'forecasts' and schemaname = 'public'`,
      );
      const indexNames = indexRes.rows.map((r) => r.indexname);
      expect(indexNames).toContain('forecasts_workspace_created_at_id_idx');
      expect(indexNames).toContain('forecasts_created_by_idx');
    });

    it('verifies jobs_type_check allows balance_forecast', async () => {
      const checkRes = await admin.query<{ condef: string }>(
        `select pg_get_constraintdef(oid) as condef
         from pg_constraint
         where conname = 'jobs_type_check' and conrelid = 'public.jobs'::regclass`,
      );
      expect(checkRes.rows[0]?.condef).toContain('balance_forecast');
    });

    it('database CHECK constraint rejects invalid status on direct insert', async () => {
      const jobId = randomUUID();
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, started_at, completed_at, created_by)
         values ($1, $2, 'balance_forecast', 'completed', now(), now(), $3)`,
        [jobId, workspace1Id, ownerId],
      );

      await expect(
        admin.query(
          `insert into public.forecasts (workspace_id, job_id, status, confidence, method, horizon_days, created_by)
           values ($1, $2, 'invalid_status', 'low', 'test', 90, $3)`,
          [workspace1Id, jobId, ownerId],
        ),
      ).rejects.toThrow(/forecasts_status_check/);
    });

    it('database CHECK constraint rejects horizon_days out of range on direct insert', async () => {
      const jobId = randomUUID();
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, started_at, completed_at, created_by)
         values ($1, $2, 'balance_forecast', 'completed', now(), now(), $3)`,
        [jobId, workspace1Id, ownerId],
      );

      await expect(
        admin.query(
          `insert into public.forecasts (workspace_id, job_id, status, confidence, method, horizon_days, created_by)
           values ($1, $2, 'completed', 'low', 'test', 731, $3)`,
          [workspace1Id, jobId, ownerId],
        ),
      ).rejects.toThrow(/forecasts_horizon_days_range_check/);
    });

    it('database CHECK constraint rejects non-array assumptions on direct insert', async () => {
      const jobId = randomUUID();
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, started_at, completed_at, created_by)
         values ($1, $2, 'balance_forecast', 'completed', now(), now(), $3)`,
        [jobId, workspace1Id, ownerId],
      );

      await expect(
        admin.query(
          `insert into public.forecasts (workspace_id, job_id, status, confidence, method, horizon_days, assumptions, created_by)
           values ($1, $2, 'completed', 'low', 'test', 90, '{"invalid": true}'::jsonb, $3)`,
          [workspace1Id, jobId, ownerId],
        ),
      ).rejects.toThrow(/forecasts_assumptions_is_array_check/);
    });

    it('enforces composite foreign key preventing forecast from pointing to job in different workspace', async () => {
      const ws2JobId = randomUUID();
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, started_at, completed_at, created_by)
         values ($1, $2, 'balance_forecast', 'completed', now(), now(), $3)`,
        [ws2JobId, workspace2Id, otherOwnerId],
      );

      await expect(
        admin.query(
          `insert into public.forecasts (workspace_id, job_id, status, confidence, method, horizon_days, created_by)
           values ($1, $2, 'completed', 'low', 'test', 90, $3)`,
          [workspace1Id, ws2JobId, ownerId],
        ),
      ).rejects.toThrow(/forecasts_job_workspace_fkey/);
    });
  });

  describe('POST /v1/forecasts/balance operation', () => {
    it('returns 202 queued with no forecast row, then drainOnce completes the pinned forecast', async () => {
      const previousClock = forecastClock;
      forecastClock = () => new Date(FIXED_NOW.toISOString());
      try {
        const key = randomUUID();
        const res = await application.inject({
          method: 'POST',
          url: '/v1/forecasts/balance',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspacePinnedId,
            'idempotency-key': key,
          },
          payload: {
            horizonDays: 90,
          },
        });

        expect(res.statusCode).toBe(202);
        const job = JSON.parse(res.payload);
        expect(job.type).toBe('balance_forecast');
        expect(job.status).toBe('queued');
        expect(job.resultResourceId).toBeNull();
        expect(job.id).toEqual(expect.any(String));
        expect(job.createdAt).toEqual(expect.any(String));

        const before = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.forecasts where job_id = $1::uuid`,
          [job.id],
        );
        expect(before.rows[0]?.count).toBe('0');

        const completed = await drainUntilTerminal(job.id);
        expect(completed.status).toBe('completed');
        expect(completed.result_resource_id).toEqual(expect.any(String));

        const forecastId = completed.result_resource_id as string;
        const dbRes = await admin.query<{
          id: string;
          job_id: string;
          status: string;
          horizon_days: number;
        }>(
          `select id, job_id, status, horizon_days from public.forecasts where id = $1::uuid`,
          [forecastId],
        );
        expect(dbRes.rows[0]?.id).toBe(forecastId);
        expect(dbRes.rows[0]?.job_id).toBe(job.id);
        expect(dbRes.rows[0]?.status).toBe('completed');
        expect(dbRes.rows[0]?.horizon_days).toBe(90);

        const getRes = await application.inject({
          method: 'GET',
          url: `/v1/forecasts/${forecastId}`,
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspacePinnedId,
          },
        });
        expect(getRes.statusCode).toBe(200);
        const forecast = JSON.parse(getRes.payload);
        expect(forecast.id).toBe(forecastId);
        expect(forecast.status).toBe('completed');
        expect(forecast.series).toHaveLength(90);
        expect(forecast.method).toBe(FORECAST_METHOD);
        expect(forecast.confidence).toBe('medium');
        expect(forecast.assumptions).toContain('3 month(s) of history used.');
        expect(forecast.series[0].expected.currency).toBe('USD');
        expect(forecast.series[0]).toEqual({
          date: '2026-09-05',
          expected: { amountMinor: '52214667', currency: 'USD' },
          lowerBound: { amountMinor: '52207466', currency: 'USD' },
          upperBound: { amountMinor: '52221868', currency: 'USD' },
        });
        expect(forecast.series[44]).toEqual({
          date: '2026-10-19',
          expected: { amountMinor: '52508015', currency: 'USD' },
          lowerBound: { amountMinor: '52183977', currency: 'USD' },
          upperBound: { amountMinor: '52832053', currency: 'USD' },
        });
        expect(forecast.series[89]).toEqual({
          date: '2026-12-03',
          expected: { amountMinor: '52808030', currency: 'USD' },
          lowerBound: { amountMinor: '52159955', currency: 'USD' },
          upperBound: { amountMinor: '53456105', currency: 'USD' },
        });

        const transitions = await admin.query<{
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
        expect(
          transitions.rows.map((row) => [
            row.from_status,
            row.to_status,
            Number(row.attempt),
          ]),
        ).toEqual([
          [null, 'queued', 0],
          ['queued', 'processing', 1],
          ['processing', 'completed', 1],
        ]);
      } finally {
        forecastClock = previousClock;
      }
    });

    it('rolls back the forecast when another delivery completes the job before persist', async () => {
      const handlers = workerApp.get<readonly JobHandler[]>(JOB_HANDLERS);
      const original = handlers.find(
        (handler) => handler.jobType === 'balance_forecast',
      );
      if (!original) {
        throw new Error('Expected a registered balance_forecast handler');
      }
      const jobWriter = workerApp.get<JobWriter>(JOB_WRITER);
      const transaction = workerApp.get(PgTransaction);

      const racingHandler: JobHandler = {
        jobType: original.jobType,
        parsePayload: (raw, execution) => original.parsePayload(raw, execution),
        compute: async (context, client) => {
          const computed = await original.compute(context, client);
          await transaction.run(context.actorId, async (writeClient) => {
            await jobWriter.completeJob(
              writeClient,
              context.workspaceId,
              context.jobId,
              null,
            );
          });
          return computed;
        },
        persist: (context, computed, client) =>
          original.persist(context, computed, client),
      };
      runner.registerHandler(racingHandler);

      try {
        const res = await application.inject({
          method: 'POST',
          url: '/v1/forecasts/balance',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            horizonDays: 90,
          },
        });
        expect(res.statusCode).toBe(202);
        const job = JSON.parse(res.payload) as { id: string; status: string };
        expect(job.status).toBe('queued');

        const processed = await runner.drainOnce();
        expect(processed).toBe(1);

        const jobRow = await admin.query<{
          status: string;
          result_resource_id: string | null;
        }>(
          `select status, result_resource_id::text as result_resource_id
             from public.jobs
            where id = $1::uuid`,
          [job.id],
        );
        expect(jobRow.rows[0]?.status).toBe('completed');
        expect(jobRow.rows[0]?.result_resource_id).toBeNull();

        const forecasts = await admin.query<{ count: string }>(
          `select count(*)::text as count
             from public.forecasts
            where job_id = $1::uuid`,
          [job.id],
        );
        expect(forecasts.rows[0]?.count).toBe('0');

        const queueRemaining = await admin.query(
          `select msg_id
             from pgmq.q_savia_jobs
            where (message->>'job_id')::uuid = $1::uuid`,
          [job.id],
        );
        expect(queueRemaining.rows).toHaveLength(0);
      } finally {
        runner.registerHandler(original);
      }
    });

    it('returns 422 when accountIds contains an unknown id', async () => {
      const unknownId = randomUUID();
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          horizonDays: 90,
          accountIds: [acctCheckingId, unknownId],
        },
      });

      expect(res.statusCode).toBe(422);
      const problem = JSON.parse(res.payload);
      expect(problem.status).toBe(422);
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'accountIds' }),
        ]),
      );
      expect(
        problem.errors.some((e: { message: string }) =>
          e.message.includes(unknownId),
        ),
      ).toBe(true);
    });

    it('returns 422 when dual-workspace member requests account belonging to another workspace', async () => {
      // acctWs2Id belongs to workspace 2.
      // dual-member-token has active membership in both workspace 1 and workspace 2.
      // RLS allows dual-member to read rows in workspace 2, so only the workspace_id predicate
      // in checkAccountsExist prevents acctWs2Id from being accepted in workspace 1.
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          horizonDays: 30,
          accountIds: [acctCheckingId, acctWs2Id],
        },
      });

      expect(res.statusCode).toBe(422);
      const problem = JSON.parse(res.payload);
      expect(problem.status).toBe(422);
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'accountIds' }),
        ]),
      );
      expect(
        problem.errors.some((e: { message: string }) =>
          e.message.includes(acctWs2Id),
        ),
      ).toBe(true);
    });

    it('handles closed account in accountIds: contributes zero and records assumption', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          horizonDays: 90,
          accountIds: [acctCheckingId, acctClosedId],
        },
      });

      expect(res.statusCode).toBe(202);
      const job = JSON.parse(res.payload);
      expect(job.status).toBe('queued');
      const completed = await drainUntilTerminal(job.id);
      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${completed.result_resource_id}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const forecast = JSON.parse(getRes.payload);
      expect(forecast.assumptions).toContain(
        `Account ${acctClosedId} is closed and contributes zero.`,
      );
    });

    it('scopes historical flow to requested accountIds matching opening balance', async () => {
      // acctSavingsId was seeded with 500,000 minor and has zero in-window transactions.
      // All in-window flow belongs to acctCheckingId.
      // Under proper account scoping, selecting acctSavingsId alone must produce
      // an initial forecast point equal to its opening balance (500000) with zero drift.
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          horizonDays: 30,
          accountIds: [acctSavingsId],
          includeScenarios: false,
        },
      });

      expect(res.statusCode).toBe(202);
      const job = JSON.parse(res.payload);
      const completed = await drainUntilTerminal(job.id);
      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${completed.result_resource_id}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const forecast = JSON.parse(getRes.payload);
      expect(forecast.series[0].expected.amountMinor).toBe('500000');
    });

    it('fails the queued job when transaction flow row has a currency without an exchange rate', async () => {
      // Seed a transaction in workspace 1 with GBP currency (no GBP/USD rate exists)
      const gbpTxnId = randomUUID();
      const curYear = new Date().getUTCFullYear();
      const curMonth = new Date().getUTCMonth();
      const occurredAt = new Date(
        Date.UTC(curYear, curMonth - 2, 10, 12, 0, 0, 0),
      ).toISOString();

      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'income', 'confirmed', 50000, 'GBP', $4::timestamptz, $5)`,
        [gbpTxnId, workspace1Id, acctCheckingId, occurredAt, ownerId],
      );
      await admin.query(
        `insert into public.ledger_postings (id, workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at) values
          ($1, $2, $3, $4, 'account', 50000, 'USD', 'confirmed', $5::timestamptz),
          ($6, $2, $3, null, 'external', -50000, 'USD', 'confirmed', $5::timestamptz)`,
        [
          randomUUID(),
          workspace1Id,
          gbpTxnId,
          acctCheckingId,
          occurredAt,
          randomUUID(),
        ],
      );

      try {
        const res = await application.inject({
          method: 'POST',
          url: '/v1/forecasts/balance',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            horizonDays: 90,
          },
        });

        expect(res.statusCode).toBe(202);
        const job = JSON.parse(res.payload);
        const completed = await drainUntilTerminal(job.id);
        expect(completed.status).toBe('failed');
        expect(completed.result_resource_id).toBeNull();
        expect(JSON.stringify(completed.error)).toMatch(/GBP/i);
        const forecasts = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.forecasts where job_id = $1::uuid`,
          [job.id],
        );
        expect(forecasts.rows[0]?.count).toBe('0');
      } finally {
        // Clean up GBP postings and transaction so remaining tests stay clean
        await admin.query(
          `delete from public.ledger_postings where transaction_id = $1::uuid`,
          [gbpTxnId],
        );
        await admin.query(
          `delete from public.transactions where id = $1::uuid`,
          [gbpTxnId],
        );
      }
    });

    it('excludes transactions having disallowed posting status via not exists predicate', async () => {
      // The disallowed transaction in Month -5 has amount 500,000.00 USD (50,000,000 minor).
      // Because it has one pending posting, it must be excluded.
      // Since Month -5 has no other rows, monthsOfHistoryAvailable must be 3 (not 4).
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          horizonDays: 90,
        },
      });

      expect(res.statusCode).toBe(202);
      const job = JSON.parse(res.payload);
      const completed = await drainUntilTerminal(job.id);
      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${completed.result_resource_id}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const forecast = JSON.parse(getRes.payload);

      // Verify that Month -5 was excluded: observation count is exactly 3
      expect(forecast.assumptions).toContain('3 month(s) of history used.');
    });

    it('excludes confirmed transactions with no qualifying postings via positive exists predicate alone', async () => {
      // Seed a confirmed transaction in Month -6 with no qualifying ledger postings.
      // Negative predicate (not exists pending) DOES NOT exclude it because it has no pending postings.
      // Only the positive predicate (exists confirmed posting) excludes it.
      // When positive predicate is intact: Month -6 is excluded, history months count is exactly 3.
      // When positive predicate is removed: Month -6 is included, history months count becomes 4 (going red).
      const txnPositiveOnlyId = randomUUID();
      const curYear = new Date().getUTCFullYear();
      const curMonth = new Date().getUTCMonth();
      const monthMinus6 = new Date(
        Date.UTC(curYear, curMonth - 6, 15, 12, 0, 0, 0),
      ).toISOString();

      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'income', 'confirmed', 700000, 'USD', $4::timestamptz, $5)`,
        [txnPositiveOnlyId, workspace1Id, acctCheckingId, monthMinus6, ownerId],
      );

      try {
        const res = await application.inject({
          method: 'POST',
          url: '/v1/forecasts/balance',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            horizonDays: 90,
          },
        });

        expect(res.statusCode).toBe(202);
        const job = JSON.parse(res.payload);
        const completed = await drainUntilTerminal(job.id);
        const getRes = await application.inject({
          method: 'GET',
          url: `/v1/forecasts/${completed.result_resource_id}`,
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
          },
        });
        const forecast = JSON.parse(getRes.payload);
        expect(forecast.assumptions).toContain('3 month(s) of history used.');
      } finally {
        await admin.query(
          `delete from public.transactions where id = $1::uuid`,
          [txnPositiveOnlyId],
        );
      }
    });

    it('counts only history months with actual flow rows instead of all 12 buckets', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          horizonDays: 90,
        },
      });

      expect(res.statusCode).toBe(202);
      const job = JSON.parse(res.payload);
      const completed = await drainUntilTerminal(job.id);
      const getRes = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${completed.result_resource_id}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      const forecast = JSON.parse(getRes.payload);

      // Only 3 months had rows, not all 12
      expect(forecast.assumptions).toContain('3 month(s) of history used.');
      expect(forecast.confidence).toBe('medium');
    });

    it('incorporates most recent completed scenario run when includeScenarios is true', async () => {
      // Create a scenario
      const scenarioId = randomUUID();
      await admin.query(
        `insert into public.scenarios (id, workspace_id, name, assumptions, created_by)
         values ($1, $2, 'Baseline Scenario', '[{"type":"income_change","value":{}}]'::jsonb, $3)`,
        [scenarioId, workspace1Id, ownerId],
      );

      // Seed 3 scenario runs:
      // Run 1 (older, completed): 50,000 minor
      // Run 2 (newer, completed): 150,000 minor -> SHOULD BE PICKED
      // Run 3 (newest, failed): 999,999 minor -> SHOULD BE IGNORED
      const run1Id = randomUUID();
      const run2Id = randomUUID();
      const run3Id = randomUUID();

      try {
        await admin.query(
          `insert into public.scenario_runs (id, workspace_id, scenario_id, status, baseline, projected, difference, created_at, created_by)
           values
             ($1, $2, $3, 'completed', '{}'::jsonb, '{"monthlySavingsCapacityMinor": "50000"}'::jsonb, '{}'::jsonb, now() - interval '2 days', $4),
             ($5, $2, $3, 'completed', '{}'::jsonb, '{"monthlySavingsCapacityMinor": "150000"}'::jsonb, '{}'::jsonb, now() - interval '1 day', $4),
             ($6, $2, $3, 'failed', '{}'::jsonb, '{"monthlySavingsCapacityMinor": "999999"}'::jsonb, '{}'::jsonb, now(), $4)`,
          [run1Id, workspace1Id, scenarioId, ownerId, run2Id, run3Id],
        );

        const res = await application.inject({
          method: 'POST',
          url: '/v1/forecasts/balance',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            horizonDays: 90,
            includeScenarios: true,
          },
        });

        expect(res.statusCode).toBe(202);
        const job = JSON.parse(res.payload);
        const completed = await drainUntilTerminal(job.id);
        const getRes = await application.inject({
          method: 'GET',
          url: `/v1/forecasts/${completed.result_resource_id}`,
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
          },
        });
        const forecast = JSON.parse(getRes.payload);
        expect(forecast.assumptions).toContain(
          `Applied scenario run ${run2Id}.`,
        );
        expect(forecast.assumptions).not.toContain(
          `Applied scenario run ${run1Id}.`,
        );
        expect(forecast.assumptions).not.toContain(
          `Applied scenario run ${run3Id}.`,
        );
        // Since stdDev is 0 with scenario run, lowerBound equals upperBound
        expect(forecast.series[0].lowerBound.amountMinor).toBe(
          forecast.series[0].upperBound.amountMinor,
        );
      } finally {
        await admin.query(
          `delete from public.scenario_runs where scenario_id = $1::uuid`,
          [scenarioId],
        );
        await admin.query(`delete from public.scenarios where id = $1::uuid`, [
          scenarioId,
        ]);
      }
    });

    it('ignores completed scenario run with malformed projected json lacking capacity', async () => {
      // Create a valid scenario and insert a completed run with projected = '{}'
      const malformedScenarioId = randomUUID();
      const malformedRunId = randomUUID();

      await admin.query(
        `insert into public.scenarios (id, workspace_id, name, assumptions, created_by)
         values ($1, $2, 'Malformed Projection Scenario', '[{"type":"income_change","value":{}}]'::jsonb, $3)`,
        [malformedScenarioId, workspace1Id, ownerId],
      );

      try {
        await admin.query(
          `insert into public.scenario_runs (id, workspace_id, scenario_id, status, baseline, projected, difference, created_at, created_by)
           values ($1, $2, $3, 'completed', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), $4)`,
          [malformedRunId, workspace1Id, malformedScenarioId, ownerId],
        );

        const res = await application.inject({
          method: 'POST',
          url: '/v1/forecasts/balance',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            horizonDays: 90,
            includeScenarios: true,
          },
        });

        expect(res.statusCode).toBe(202);
        const job = JSON.parse(res.payload);
        const completed = await drainUntilTerminal(job.id);
        const getRes = await application.inject({
          method: 'GET',
          url: `/v1/forecasts/${completed.result_resource_id}`,
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
          },
        });
        expect(getRes.statusCode).toBe(200);
        const forecast = JSON.parse(getRes.payload);
        expect(forecast.assumptions).toContain(
          'includeScenarios was requested but no completed scenario run existed; proceeded from history.',
        );
      } finally {
        await admin.query(
          `delete from public.scenario_runs where scenario_id = $1::uuid`,
          [malformedScenarioId],
        );
        await admin.query(`delete from public.scenarios where id = $1::uuid`, [
          malformedScenarioId,
        ]);
      }
    });

    it('idempotency: replay with same key returns original 202 and creates no second row', async () => {
      const key = randomUUID();

      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          horizonDays: 90,
        },
      });
      expect(res1.statusCode).toBe(202);
      const job1 = JSON.parse(res1.payload);

      const res2 = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          horizonDays: 90,
        },
      });
      expect(res2.statusCode).toBe(202);
      const job2 = JSON.parse(res2.payload);

      expect(job2.id).toBe(job1.id);
      expect(job2.status).toBe('queued');
      expect(job2.resultResourceId).toBeNull();

      const queuedCount = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.jobs where id = $1::uuid`,
        [job1.id],
      );
      expect(queuedCount.rows[0]?.count).toBe('1');

      const completed = await drainUntilTerminal(job1.id);
      expect(completed.status).toBe('completed');
      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text as count from public.forecasts where job_id = $1::uuid`,
        [job1.id],
      );
      expect(countRes.rows[0]?.count).toBe('1');
    });

    it('fails with the 403 Problem and no forecast row when the creator is demoted before drain', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { horizonDays: 30 },
      });
      expect(res.statusCode).toBe(202);
      const job = JSON.parse(res.payload);
      expect(job.status).toBe('queued');

      await admin.query(
        `update public.workspace_memberships
            set role = 'viewer'
          where workspace_id = $1::uuid
            and profile_id = $2::uuid`,
        [workspace1Id, editorId],
      );

      try {
        const completed = await drainUntilTerminal(job.id);
        expect(completed.status).toBe('failed');
        expect(completed.error).toEqual(
          expect.objectContaining({
            status: 403,
            code: 'forbidden',
          }),
        );
        const forecasts = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.forecasts where job_id = $1::uuid`,
          [job.id],
        );
        expect(forecasts.rows[0]?.count).toBe('0');
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

    it('rejects missing or invalid Idempotency-Key with 400', async () => {
      const resMissing = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
        payload: {
          horizonDays: 90,
        },
      });
      expect(resMissing.statusCode).toBe(400);

      const resInvalid = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': 'not-a-valid-uuid',
        },
        payload: {
          horizonDays: 90,
        },
      });
      expect(resInvalid.statusCode).toBe(400);
    });

    it('role gating: editor can create, viewer cannot (403), non-member cannot (403)', async () => {
      // Editor -> 202
      const resEditor = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { horizonDays: 30 },
      });
      expect(resEditor.statusCode).toBe(202);

      // Viewer -> 403
      const resViewer = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { horizonDays: 30 },
      });
      expect(resViewer.statusCode).toBe(403);

      // Non-member -> 403
      const resNonMember = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { horizonDays: 30 },
      });
      expect(resNonMember.statusCode).toBe(403);
    });
  });

  describe('GET /v1/forecasts/:forecastId operation', () => {
    let testForecastId: string;

    beforeAll(async () => {
      // Create a forecast to read
      const res = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { horizonDays: 60 },
      });
      const job = JSON.parse(res.payload);
      const completed = await drainUntilTerminal(job.id);
      testForecastId = completed.result_resource_id as string;
    });

    it('dual-workspace member accessing forecast of another workspace receives 404 via workspace predicate', async () => {
      // Create a forecast in workspace 2
      const resWs2 = await application.inject({
        method: 'POST',
        url: '/v1/forecasts/balance',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: { horizonDays: 30 },
      });
      expect(resWs2.statusCode).toBe(202);
      const ws2Job = JSON.parse(resWs2.payload);
      const ws2Completed = await drainUntilTerminal(ws2Job.id);
      const ws2ForecastId = ws2Completed.result_resource_id as string;

      // Attempt to read workspace 2 forecast from workspace 1 with a dual-workspace member.
      // Because dualMember is an active member of both workspaces, RLS permits reading either,
      // proving that the 404 is enforced by the SQL workspace predicate and not masked by RLS.
      const res = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${ws2ForecastId}`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
        },
      });

      expect(res.statusCode).toBe(404);
      const problem = JSON.parse(res.payload);
      expect(problem.status).toBe(404);

      // Verify the same dual-member CAN read it when providing workspace2Id
      const resCorrectWs = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${ws2ForecastId}`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
        },
      });
      expect(resCorrectWs.statusCode).toBe(200);
    });

    it('role gating: owner, editor, viewer can read (200), non-member is forbidden (403)', async () => {
      // Owner -> 200
      const resOwner = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${testForecastId}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resOwner.statusCode).toBe(200);

      // Editor -> 200
      const resEditor = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${testForecastId}`,
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resEditor.statusCode).toBe(200);

      // Viewer -> 200
      const resViewer = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${testForecastId}`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resViewer.statusCode).toBe(200);

      // Non-member -> 403
      const resNonMember = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${testForecastId}`,
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resNonMember.statusCode).toBe(403);
    });

    it('returns 404 for non-existent forecastId in workspace', async () => {
      const nonExistentId = randomUUID();
      const res = await application.inject({
        method: 'GET',
        url: `/v1/forecasts/${nonExistentId}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for malformed forecastId UUID', async () => {
      const res = await application.inject({
        method: 'GET',
        url: '/v1/forecasts/not-a-valid-uuid',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
