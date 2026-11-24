// Migrations under test: 202609170028_standalone_transaction_posting_updates.sql,
// 202609170031_l16_classification_bulk.sql,
// 202609170035_normalize_imported_transaction_amounts.sql.
import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import {
  TRANSACTION_UPDATE_OUTCOMES,
  type Transaction,
  type UpdateTransactionCommand,
  type TransactionUpdateOk,
} from '../../src/ledger/ledger.port.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import {
  PgTransaction,
  type TransactionClient,
} from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { PostgresReportAdapter } from '../../src/reports/postgres-report.adapter.js';
import { buildReportGrid } from '../../src/reports/report-engine.js';
import { PostgresExportAdapter } from '../../src/exports/postgres-export.adapter.js';
import { serializeJsonBackup } from '../../src/exports/export-serializers.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('TransactionService updateTransaction database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: TransactionService;
  let idempotencyAdapter: PostgresIdempotencyAdapter;
  let app: NestFastifyApplication;

  const subjectOwner = subject(901);
  const subjectAdmin = subject(902);
  const subjectEditor = subject(903);
  const subjectViewer = subject(904);
  const subjectNonMember = subject(905);
  const subjectWorkspace2Owner = subject(906);

  const workspace1Id = id(951);
  const workspace2Id = id(952);
  const absentWorkspaceId = id(999);

  const accountActiveId = id(5001);
  const accountWorkspace2Id = id(5002);

  const category1Id = id(8001);
  const category2Id = id(8002);
  const categoryWs2Id = id(8003);
  const absentCategoryId = id(8099);
  const payee1Id = id(8101);
  const payee2Id = id(8102);
  const payeeWs2Id = id(8103);
  const absentPayeeId = id(8199);
  const tag1Id = id(8201);
  const tag2Id = id(8202);

  const txnOwnerTarget = id(7001);
  const txnAdminTarget = id(7002);
  const txnEditorTarget = id(7003);
  const txnNullableTarget = id(7004);
  const txnRaceTarget = id(7005);
  const txnStaleTarget = id(7006);
  const txnIdempotencyTarget = id(7007);
  const txnVoidedTarget = id(7008);
  const txnReconciledTarget = id(7009);
  const txnWorkspace2Target = id(7010);
  const absentTxnId = id(7999);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    idempotencyAdapter = new PostgresIdempotencyAdapter();
    service = new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      idempotencyAdapter,
    );

    // 1. Auth Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'txn-upd-owner@example.test',
        subjectAdmin,
        'txn-upd-admin@example.test',
        subjectEditor,
        'txn-upd-editor@example.test',
        subjectViewer,
        'txn-upd-viewer@example.test',
        subjectNonMember,
        'txn-upd-nonmember@example.test',
        subjectWorkspace2Owner,
        'txn-upd-ws2-owner@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectOwner, 'txn-upd-owner@example.test', 'Txn Upd Owner'],
      [subjectAdmin, 'txn-upd-admin@example.test', 'Txn Upd Admin'],
      [subjectEditor, 'txn-upd-editor@example.test', 'Txn Upd Editor'],
      [subjectViewer, 'txn-upd-viewer@example.test', 'Txn Upd Viewer'],
      [
        subjectNonMember,
        'txn-upd-nonmember@example.test',
        'Txn Upd Non Member',
      ],
      [
        subjectWorkspace2Owner,
        'txn-upd-ws2-owner@example.test',
        'Txn Upd WS2 Owner',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 3. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Txn Upd Workspace One'],
      [workspace2Id, 'Txn Upd Workspace Two'],
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
              ($1, $3, 'administrator', 'active'),
              ($1, $4, 'editor', 'active'),
              ($1, $5, 'viewer', 'active'),
              ($6, $7, 'owner', 'active'),
              ($6, $2, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        workspace2Id,
        subjectWorkspace2Owner,
      ],
    );

    // 5. Accounts (satisfying accounts check: (status = 'closed') = (closed_at is not null))
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'Active Checking', 'checking', 'USD', 'active', null, $3),
              ($4, $5, 'Workspace 2 Checking', 'checking', 'USD', 'active', null, $6)`,
      [
        accountActiveId,
        workspace1Id,
        subjectOwner,
        accountWorkspace2Id,
        workspace2Id,
        subjectWorkspace2Owner,
      ],
    );

    // 5b. Categories and Payees (satisfying foreign key bindings)
    await admin.query(
      `insert into public.categories (id, workspace_id, name, kind, created_by)
       values ($1, $2, 'Category 1', 'expense', $3),
              ($4, $2, 'Category 2', 'expense', $3),
              ($5, $6, 'Workspace 2 Category', 'expense', $7)`,
      [
        category1Id,
        workspace1Id,
        subjectOwner,
        category2Id,
        categoryWs2Id,
        workspace2Id,
        subjectWorkspace2Owner,
      ],
    );
    await admin.query(
      `insert into public.payees (id, workspace_id, name, created_by)
       values ($1, $2, 'Payee 1', $3),
              ($4, $2, 'Payee 2', $3),
              ($5, $6, 'Workspace 2 Payee', $7)`,
      [
        payee1Id,
        workspace1Id,
        subjectOwner,
        payee2Id,
        payeeWs2Id,
        workspace2Id,
        subjectWorkspace2Owner,
      ],
    );

    // 6. Transactions (satisfying check: (status = 'voided') = (voided_at is not null))
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
          description, notes, category_id, payee_id, receipt_id, tag_ids, voided_at, created_by, created_at, updated_at, version)
       values
         ($1, $2, $3, 'expense', 'confirmed', 5000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Initial description', 'Initial notes', $4::uuid, $5::uuid, null, $6::uuid[], null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($8, $2, $3, 'expense', 'draft', 6000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Admin initial', null, null, null, null, null, null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($9, $2, $3, 'income', 'pending', 7000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Editor initial', null, null, null, null, null, null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($10, $2, $3, 'expense', 'confirmed', 8000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'To be cleared', 'Notes to clear', $4::uuid, $5::uuid, null, $6::uuid[], null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($11, $2, $3, 'expense', 'confirmed', 9000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Race Target', null, null, null, null, null, null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($12, $2, $3, 'expense', 'confirmed', 10000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Stale Target', null, null, null, null, null, null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($13, $2, $3, 'expense', 'confirmed', 11000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Idempotency Target', null, null, null, null, null, null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($14, $2, $3, 'expense', 'voided', 12000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Voided Target', null, null, null, null, null, '2026-08-20T12:00:00.000Z'::timestamptz, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($15, $2, $3, 'expense', 'reconciled', 13000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Reconciled Target', null, null, null, null, null, null, $7, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($16, $17, $18, 'expense', 'confirmed', 14000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Workspace 2 Target', null, null, null, null, null, null, $19, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1)`,
      [
        txnOwnerTarget,
        workspace1Id,
        accountActiveId,
        category1Id,
        payee1Id,
        [tag1Id],
        subjectOwner,
        txnAdminTarget,
        txnEditorTarget,
        txnNullableTarget,
        txnRaceTarget,
        txnStaleTarget,
        txnIdempotencyTarget,
        txnVoidedTarget,
        txnReconciledTarget,
        txnWorkspace2Target,
        workspace2Id,
        accountWorkspace2Id,
        subjectWorkspace2Owner,
      ],
    );

    // 7. Ledger Postings for seeded transactions (balanced pairs summing to zero)
    const seedTxns = [
      { id: txnOwnerTarget, amount: '5000', status: 'confirmed' },
      { id: txnAdminTarget, amount: '6000', status: 'draft' },
      { id: txnEditorTarget, amount: '7000', status: 'pending' },
      { id: txnNullableTarget, amount: '8000', status: 'confirmed' },
      { id: txnRaceTarget, amount: '9000', status: 'confirmed' },
      { id: txnStaleTarget, amount: '10000', status: 'confirmed' },
      { id: txnIdempotencyTarget, amount: '11000', status: 'confirmed' },
      { id: txnVoidedTarget, amount: '12000', status: 'confirmed' }, // Postings status enum check excludes voided
      { id: txnReconciledTarget, amount: '13000', status: 'reconciled' },
    ];

    for (const t of seedTxns) {
      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1::uuid, $2::uuid, $3::uuid, 'account', $4, 'USD', $5, '2026-08-20T10:00:00.000Z'::timestamptz),
                ($1::uuid, $2::uuid, null, 'external', $6, 'USD', $5, '2026-08-20T10:00:00.000Z'::timestamptz)`,
        [
          workspace1Id,
          t.id,
          accountActiveId,
          t.amount,
          t.status,
          `-${t.amount}`,
        ],
      );
    }

    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: (token: string) =>
          Promise.resolve({
            subject:
              token === 'session-other-writer'
                ? subjectWorkspace2Owner
                : subjectOwner,
            authMethod: 'session',
          }),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin.query('delete from public.budgets where workspace_id = $1', [
      workspace2Id,
    ]);
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      workspace1Id,
      workspace2Id,
    ]);
    await admin.query(
      `delete from auth.users where id in ($1, $2, $3, $4, $5, $6)`,
      [
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        subjectNonMember,
        subjectWorkspace2Owner,
      ],
    );
    await pool.end();
    await admin.end();
  });

  const past = '2020-01-01T00:00:00.000Z';
  const future = '2099-01-01T00:00:00.000Z';
  const balanceHeaders = {
    authorization: 'Bearer session-owner',
    'x-workspace-id': workspace2Id,
  };
  const usd = (amountMinor: string) => ({ amountMinor, currency: 'USD' });

  async function createBookedIncome(occurredAt = past) {
    const account = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
      payload: {
        name: `PATCH balance ${randomUUID()}`,
        type: 'checking',
        currency: 'USD',
      },
    });
    expect(account.statusCode, account.payload).toBe(201);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
      payload: {
        accountId: account.json<{ id: string }>().id,
        type: 'income',
        amount: usd('1234'),
        occurredAt,
        status: 'confirmed',
      },
    });
    expect(response.statusCode, response.payload).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    return response.json<Transaction>();
  }

  async function expectBalance(
    accountId: string,
    asOf: string,
    native: string,
    pending = '0',
  ) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${accountId}/balance?asOf=${encodeURIComponent(asOf)}`,
      headers: balanceHeaders,
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toMatchObject({
      nativeBalance: usd(native),
      pendingBalance: usd(pending),
      reconciledBalance: usd('0'),
    });
    expect(response.json()).not.toHaveProperty('availableBalance');
  }

  describe('atomic bulk transaction actions', () => {
    const postBulk = (
      payload: object,
      key = randomUUID(),
      requestHeaders = balanceHeaders,
    ) =>
      app.inject({
        method: 'POST',
        url: '/v1/transactions/bulk',
        headers: { ...requestHeaders, 'idempotency-key': key },
        payload,
      });
    const read = (id: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/transactions/${id}`,
        headers: balanceHeaders,
      });

    it('writes in target order, leaves postings unchanged, and replays before version checks', async () => {
      const a = await createBookedIncome();
      const b = await createBookedIncome();
      const targets = [a, b]
        .map(({ id, version }) => ({ id, expectedVersion: version }))
        .sort((x, y) => y.id.localeCompare(x.id));
      const key = randomUUID();
      const payload = { targets, action: { type: 'excludeFromReports' } };
      const response = await postBulk(payload, key);
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toEqual({
        updated: targets.map(({ id }) => ({ id, version: 2 })),
      });
      await expectBalance(a.accountId, future, '1234');
      for (const target of targets) {
        expect((await read(target.id)).json()).toMatchObject({
          excludedFromReports: true,
          version: 2,
        });
      }
      const replay = await postBulk(payload, key);
      expect(replay.statusCode).toBe(200);
      expect(replay.payload).toBe(response.payload);
      const conflict = await postBulk(
        { ...payload, action: { type: 'archive' } },
        key,
      );
      expect(conflict.statusCode).toBe(409);
      expect((await read(a.id)).json()).toMatchObject({
        version: 2,
        excludedFromReports: true,
      });
    });

    it('rejects an entire batch on a stale or invisible target and never burns its key', async () => {
      const txn = await createBookedIncome();
      const other = await createBookedIncome();
      const target = { id: txn.id, expectedVersion: 1 };
      const key = randomUUID();
      const before = await read(txn.id);
      const action = { type: 'archive' };
      for (const [id, expectedVersion, status] of [
        [other.id, 2, 412],
        [txnOwnerTarget, 1, 404],
      ] as const) {
        const response = await postBulk(
          { targets: [target, { id, expectedVersion }], action },
          key,
        );
        expect(response.statusCode, response.payload).toBe(status);
        expect((await read(txn.id)).payload).toBe(before.payload);
      }
      expect(
        (await postBulk({ targets: [target], action }, key)).statusCode,
      ).toBe(200);
      expect((await read(txn.id)).json()).toMatchObject({
        archived: true,
        version: 2,
      });
      for (const id of [txnVoidedTarget, txnReconciledTarget]) {
        const headers = { ...balanceHeaders, 'x-workspace-id': workspace1Id };
        const get = () =>
          app.inject({ method: 'GET', url: `/v1/transactions/${id}`, headers });
        const old = await get();
        expect(old.statusCode).toBe(200);
        const result = await app.inject({
          method: 'POST',
          url: '/v1/transactions/bulk',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { targets: [{ id, expectedVersion: 1 }], action },
        });
        expect(result.statusCode, result.payload).toBe(422);
        expect((await get()).payload).toBe(old.payload);
      }
    });

    it('returns 412 when a void made any target version stale', async () => {
      const first = await createBookedIncome();
      const second = await createBookedIncome();
      const voided = await app.inject({
        method: 'POST',
        url: `/v1/transactions/${second.id}/void`,
        headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
        payload: { reason: 'Duplicate ledger entry' },
      });
      expect(voided.statusCode, voided.payload).toBe(200);
      const voidedVersion = voided.json<Transaction>().version;
      expect(voidedVersion).toBe(second.version + 1);

      const ids = [first.id, second.id];
      const key = randomUUID();
      const state = async () =>
        (
          await admin.query(
            `select md5(jsonb_build_array(
              (select jsonb_agg(to_jsonb(t) order by t.id)
                 from public.transactions t where id = any($1::uuid[])),
              (select jsonb_agg(to_jsonb(p) order by p.id)
                 from public.ledger_postings p where transaction_id = any($1::uuid[])),
              (select to_jsonb(r) from public.command_idempotency_records r
                 where r.workspace_id = $2 and r.subject_id = $3 and r.idempotency_key = $4)
            )::text) as digest`,
            [ids, workspace2Id, subjectOwner, key],
          )
        ).rows;
      const before = await state();
      for (const [expectedVersion, status, title] of [
        [second.version, 412, 'Transaction version mismatch'],
        [voidedVersion, 422, 'Ineligible transaction or action'],
      ] as const) {
        const result = await postBulk(
          {
            targets: [
              { id: first.id, expectedVersion: first.version },
              { id: second.id, expectedVersion },
            ],
            action: { type: 'archive' },
          },
          key,
        );
        expect(await state()).toEqual(before);
        expect(result.statusCode, result.payload).toBe(status);
        expect(result.json()).toMatchObject({ title, status });
      }
    });

    it('checks versions after a concurrent void ahead of bulk at the account lock', async () => {
      const first = await createBookedIncome();
      const second = await createBookedIncome();
      const lock = await admin.connect();
      const pid = (
        await lock.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0].pid;

      const waitFor = async (count: number) => {
        const deadline = Date.now() + 700;
        while (Date.now() < deadline) {
          const { rows } = await admin.query<{ count: number }>(
            `select count(*)::int
               from pg_locks held
               join pg_locks waiter using (locktype,database,classid,objid,objsubid)
              where held.pid=$1 and held.locktype='advisory'
                and held.granted and not waiter.granted`,
            [pid],
          );
          if (rows[0].count === count) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`expected ${count} blocked requests`);
      };

      const headers = {
        ...balanceHeaders,
        authorization: 'Bearer session-other-writer',
        'idempotency-key': randomUUID(),
      };
      const payload = {
        targets: [first, second].map(({ id, version }) => ({
          id,
          expectedVersion: version,
        })),
        action: { type: 'archive' },
      };
      const firstBefore = (await read(first.id)).payload;
      const key = randomUUID();
      let voiding;
      let bulk;
      try {
        await lock.query('begin');
        await lock.query(
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [second.accountId],
        );
        voiding = app.inject({
          method: 'POST',
          url: `/v1/transactions/${second.id}/void`,
          headers,
          payload: { reason: 'race' },
        });
        await waitFor(1);
        bulk = postBulk(payload, key);
        await waitFor(2);
      } finally {
        await lock.query('rollback');
        lock.release();
      }

      expect((await voiding!).statusCode).toBe(200);
      const rejected = await bulk!;
      expect((await read(first.id)).payload).toBe(firstBefore);
      expect(rejected.statusCode, rejected.payload).toBe(412);
      expect(rejected.json()).toMatchObject({
        title: 'Transaction version mismatch',
      });
      const retry = await postBulk(
        { ...payload, targets: [payload.targets[0]] },
        key,
      );
      expect(retry.statusCode, retry.payload).toBe(200);
    });

    it('confirms 100 pending transactions in target order and applies set and clear actions', async () => {
      const ids = await transaction.run(subjectOwner, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.transactions
             (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
           select $1,$2,'income','pending',1,'USD',$4,$3
             from generate_series(1,100) returning id`,
          [workspace1Id, accountActiveId, subjectOwner, past],
        );
        await client.query(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           select $1,t.id,leg.aid,leg.kind,leg.amount,'USD','pending',$4
             from unnest($3::uuid[]) as t(id)
             cross join (values ($2::uuid,'account',1),(null,'external',-1))
               leg(aid,kind,amount)`,
          [workspace1Id, accountActiveId, rows.map(({ id }) => id), past],
        );
        return rows.map(({ id }) => id).reverse();
      });
      const tagIds = [randomUUID(), randomUUID()];
      await admin.query(
        `insert into public.tags(id,workspace_id,name,created_by)
         values ($1,$3,'review tag 1',$4),($2,$3,'review tag 2',$4)`,
        [...tagIds, workspace1Id, subjectOwner],
      );
      const headers = { ...balanceHeaders, 'x-workspace-id': workspace1Id };
      let version = 1;
      for (const action of [
        { type: 'confirm' },
        { type: 'categorize', categoryId: category1Id },
        { type: 'categorize', categoryId: null },
        { type: 'setPayee', payeeId: payee1Id },
        { type: 'setPayee', payeeId: null },
        { type: 'tag', tagIds },
        { type: 'tag', tagIds: [tagIds[0]] },
        { type: 'archive' },
        { type: 'unarchive' },
      ]) {
        const response = await postBulk(
          {
            targets: ids.map((id) => ({ id, expectedVersion: version })),
            action,
          },
          randomUUID(),
          headers,
        );
        expect(response.statusCode, response.payload).toBe(200);
        version++;
        expect(response.json()).toEqual({
          updated: ids.map((id) => ({ id, version })),
        });
      }
      const result = await app.inject({
        method: 'GET',
        url: `/v1/transactions/${ids[0]}`,
        headers,
      });
      expect(result.statusCode, result.payload).toBe(200);
      expect(result.json()).toMatchObject({
        status: 'confirmed',
        categoryId: null,
        payeeId: null,
        tagIds,
        version,
      });
      expect(result.json()).not.toHaveProperty('archived');
      expect(
        (
          await admin.query(
            `select count(*)::int as legs from public.ledger_postings
             where transaction_id = any($1::uuid[]) and status = 'confirmed'`,
            [ids],
          )
        ).rows,
      ).toEqual([{ legs: 200 }]);
    });

    it('rejects empty, duplicate (case insensitive), oversized and unsupported requests without mutation', async () => {
      const txn = await createBookedIncome();
      const target = { id: txn.id, expectedVersion: 1 };
      const before = await read(txn.id);
      const action = { type: 'archive' };
      for (const payload of [
        { targets: [], action },
        {
          targets: [target, { id: txn.id.toUpperCase(), expectedVersion: 2 }],
          action,
        },
        {
          targets: Array.from({ length: 101 }, () => ({
            id: randomUUID(),
            expectedVersion: 1,
          })),
          action,
        },
        { targets: [target], action: { type: 'convertImported' } },
        {
          targets: [target],
          action: { type: 'convertImported', targetType: 'income' },
        },
        { targets: [target], action: { type: 'tag', tagIds: [] } },
      ]) {
        const response = await postBulk(payload);
        expect(response.statusCode, response.payload).toBe(422);
        expect((await read(txn.id)).payload).toBe(before.payload);
      }
    });

    it('serializes opposing target orders from different actors without a partial write', async () => {
      const a = await createBookedIncome();
      const b = await createBookedIncome();
      const c = await createBookedIncome();
      const targets = [a, b, c].map(({ id }) => ({ id, expectedVersion: 1 }));
      const outcomes = await Promise.all([
        postBulk({ targets, action: { type: 'archive' } }),
        postBulk(
          {
            targets: [...targets].reverse(),
            action: { type: 'setExtraordinary', extraordinary: true },
          },
          randomUUID(),
          {
            ...balanceHeaders,
            authorization: 'Bearer session-other-writer',
          },
        ),
      ]);
      expect(outcomes.map((response) => response.statusCode).sort()).toEqual([
        200, 412,
      ]);
      const archiveWon = outcomes[0].statusCode === 200;
      const winnerOrder = archiveWon ? targets : [...targets].reverse();
      const winner = outcomes.find((response) => response.statusCode === 200);
      expect(winner?.json()).toEqual({
        updated: winnerOrder.map(({ id }) => ({ id, version: 2 })),
      });
      for (const { id } of targets) {
        const response = await read(id);
        expect(response.statusCode).toBe(200);
        const { archived, extraordinary, version } =
          response.json<Transaction>();
        expect({
          archived: archived ?? false,
          extraordinary: extraordinary ?? false,
          version,
        }).toEqual({
          archived: archiveWon,
          extraordinary: !archiveWon,
          version: 2,
        });
      }
    });

    it('converts only sign-compatible imported adjustments without changing a balance or losing rollback provenance', async () => {
      const account = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
        payload: {
          name: `Imported ${randomUUID()}`,
          type: 'checking',
          currency: 'USD',
        },
      });
      expect(account.statusCode, account.payload).toBe(201);
      const accountId = account.json<{ id: string }>().id;
      const jobId = randomUUID();
      await admin.query(
        `insert into public.import_jobs(id,workspace_id,file_name,status,account_id,detected_format,created_by)
        values ($1,$2,'fixture.csv','completed',$3,'csv',$4)`,
        [jobId, workspace2Id, accountId, subjectOwner],
      );
      await transaction.run(subjectOwner, (client) =>
        service.createImportedTransactions(
          client,
          workspace2Id,
          subjectOwner,
          ['500', '-900', '0'].map((amountMinor) => ({
            accountId,
            amountMinor,
            currency: 'USD',
            occurredAt: past,
            description: `Imported ${amountMinor}`,
            importJobId: jobId,
          })),
        ),
      );
      const listing = await app.inject({
        method: 'GET',
        url: `/v1/transactions?accountId=${accountId}`,
        headers: balanceHeaders,
      });
      expect(listing.statusCode).toBe(200);
      const rows = listing.json<{ items: Transaction[] }>().items;
      expect(rows).toHaveLength(3);
      function atAmount(amountMinor: string): Transaction {
        const row = rows.find((txn) => txn.amount.amountMinor === amountMinor);
        if (!row)
          throw new Error(`Missing imported transaction ${amountMinor}`);
        return row;
      }
      const readSummary = async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/analytics/summary?from=2020-01-01&to=2020-01-01',
          headers: balanceHeaders,
        });
        expect(response.statusCode, response.payload).toBe(200);
        const body = response.json<{
          income: { amountMinor: string };
          expenses: { amountMinor: string };
          savingsCapacity: { amountMinor: string };
        }>();
        return {
          income: BigInt(body.income.amountMinor),
          expenses: BigInt(body.expenses.amountMinor),
          savings: BigInt(body.savingsCapacity.amountMinor),
        };
      };
      const beforeConversion = await readSummary();
      const postings = async () =>
        (
          await admin.query(
            'select * from public.ledger_postings where transaction_id = any($1::uuid[]) order by id',
            [rows.map(({ id }) => id)],
          )
        ).rows;
      const originalPostings = await postings();
      const positive = atAmount('500');
      const negative = atAmount('-900');
      const zero = atAmount('0');
      const target = (row: Transaction) => ({
        id: row.id,
        expectedVersion: row.version,
      });
      const convert = (
        targetType: 'income' | 'expense',
        targets: Transaction[],
        key = randomUUID(),
      ) =>
        postBulk(
          {
            targets: targets.map(target),
            action: { type: 'convertImported', targetType },
          },
          key,
        );
      const unchanged = await Promise.all(rows.map(({ id }) => read(id)));
      const key = randomUUID();
      for (const [type, batch] of [
        ['income', [positive, negative]],
        ['income', [positive, zero]],
        ['expense', [negative, positive]],
        ['expense', [negative, zero]],
      ] as const) {
        const rejected = await convert(type, [...batch], key);
        expect(rejected.statusCode, rejected.payload).toBe(422);
        expect(
          (await Promise.all(rows.map(({ id }) => read(id)))).map(
            ({ payload }) => payload,
          ),
        ).toEqual(unchanged.map(({ payload }) => payload));
        await expectBalance(accountId, future, '-400');
      }
      for (const [type, txn] of [
        ['income', positive],
        ['expense', negative],
      ] as const) {
        const response = await convert(
          type,
          [txn],
          type === 'income' ? key : randomUUID(),
        );
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toEqual({
          updated: [{ id: txn.id, version: 2 }],
        });
        const converted = await read(txn.id);
        expect(converted.statusCode, converted.payload).toBe(200);
        expect(converted.json()).toMatchObject({
          type,
          description: txn.description,
          version: 2,
        });
        expect(await postings()).toEqual(originalPostings);
      }
      await expectBalance(accountId, future, '-400');
      const afterConversion = await readSummary();
      expect(afterConversion.expenses - beforeConversion.expenses).toBe(900n);
      expect(afterConversion.income - beforeConversion.income).toBe(500n);
      expect(afterConversion.savings - beforeConversion.savings).toBe(-400n);
      expect((await read(negative.id)).json()).toMatchObject({
        amount: usd('900'),
      });
      expect((await read(positive.id)).json()).toMatchObject({
        amount: usd('500'),
      });
      const nativeCategory = randomUUID();
      const importedCategory = randomUUID();
      const budgetId = randomUUID();
      const date = '2020-01-01';

      await admin.query(
        `insert into public.categories(id,workspace_id,name,kind,created_by)
         values ($1,$3,'Native expense control','expense',$4),
                ($2,$3,'Imported expense','expense',$4)`,
        [nativeCategory, importedCategory, workspace2Id, subjectOwner],
      );

      const nativeIds: string[] = [];
      for (const [type, amountMinor] of [
        ['expense', '900'],
        ['income', '500'],
      ] as const) {
        const created = await app.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
          payload: {
            type,
            amount: usd(amountMinor),
            occurredAt: past,
            accountId: accountWorkspace2Id,
            status: 'confirmed',
            ...(type === 'expense' ? { categoryId: nativeCategory } : {}),
          },
        });
        expect(created.statusCode, created.payload).toBe(201);
        nativeIds.push(created.json<Transaction>().id);
      }

      const categorized = await postBulk({
        targets: [{ id: negative.id, expectedVersion: 2 }],
        action: { type: 'categorize', categoryId: importedCategory },
      });
      expect(categorized.statusCode, categorized.payload).toBe(200);

      await admin.query(
        `insert into public.budgets(id,workspace_id,name,method,period_start,period_end,currency,created_by)
         values ($1,$2,'Imported parity budget','envelope',$3,'2020-01-31','USD',$4)`,
        [budgetId, workspace2Id, date, subjectOwner],
      );
      await admin.query(
        `insert into public.budget_allocations
           (workspace_id,budget_id,category_id,planned_minor,rollover_policy)
         values ($1,$2,$3,1500,'none'),($1,$2,$4,1500,'none')`,
        [workspace2Id, budgetId, nativeCategory, importedCategory],
      );

      await transaction.runRead(subjectOwner, async (client) => {
        const source = await new PostgresReportAdapter().readReportSourceRows(
          client,
          workspace2Id,
          date,
          date,
          new Date(past),
        );
        const exportRows = await new PostgresExportAdapter().readRows(
          client,
          workspace2Id,
          {
            format: 'json_backup',
            resource: 'transactions',
            resourceId: null,
            from: date,
            to: date,
          },
        );
        const exported = JSON.parse(
          serializeJsonBackup(exportRows, { asOf: past }).toString(),
        ).transactions as Transaction[];
        const grid = (ids: string[]) =>
          buildReportGrid({
            rows: source.filter((row) => ids.includes(row.transactionId)),
            dimensions: ['transaction_type'],
            measures: ['sum'],
            baseCurrency: 'USD',
            budgetedMinorByBucket: new Map(),
          });
        expect.soft(grid([negative.id, positive.id])).toEqual(grid(nativeIds));
        expect
          .soft(
            exported
              .filter((row) => [negative.id, positive.id].includes(row.id))
              .map(({ type, amount }) => ({ type, amount })),
          )
          .toEqual(
            expect.arrayContaining([
              { type: 'expense', amount: usd('900') },
              { type: 'income', amount: usd('500') },
            ]),
          );
      });

      const access = await admin.query(
        `select has_column_privilege(
           'savia_application','public.transactions','amount_minor','UPDATE'
         ) as direct`,
      );
      expect(access.rows).toEqual([{ direct: false }]);

      const budget = await app.inject({
        method: 'GET',
        url: `/v1/budgets/${budgetId}`,
        headers: balanceHeaders,
      });
      expect(budget.statusCode, budget.payload).toBe(200);
      const { allocations } = budget.json<{
        allocations: { categoryId: string; actual: { amountMinor: string } }[];
      }>();
      const actual = (id: string) =>
        allocations.find((row) => row.categoryId === id)?.actual.amountMinor;
      expect(actual(nativeCategory)).toBe('900');
      expect.soft(actual(importedCategory)).toBe(actual(nativeCategory));
      const utilization = await app.inject({
        method: 'GET',
        url: `/v1/analytics/summary?from=${date}&to=${date}`,
        headers: balanceHeaders,
      });
      expect(utilization.statusCode, utilization.payload).toBe(200);
      expect.soft(utilization.json()).toMatchObject({
        budgetUtilizationPercent: 60,
      });

      const rollback = await app.inject({
        method: 'POST',
        url: `/v1/import-jobs/${jobId}/rollback`,
        headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
      });
      expect(rollback.statusCode, rollback.payload).toBe(202);
      for (const { id } of rows)
        expect((await read(id)).json()).toMatchObject({ status: 'voided' });
      await expectBalance(accountId, future, '0');
    });

    it('excludes an income from analytics while keeping its ledger balance, then restores report inclusion', async () => {
      const txn = await createBookedIncome('2026-02-11T00:01:00Z');
      const summary = () =>
        app.inject({
          method: 'GET',
          url: '/v1/analytics/summary?from=2026-02-11&to=2026-02-11',
          headers: balanceHeaders,
        });
      const before = await summary();
      expect(before.statusCode, before.payload).toBe(200);
      expect(before.json()).toMatchObject({ income: usd('1234') });
      for (const [type, version, income] of [
        ['excludeFromReports', 1, '0'],
        ['includeInReports', 2, '1234'],
      ] as const) {
        const response = await postBulk({
          targets: [{ id: txn.id, expectedVersion: version }],
          action: { type },
        });
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toEqual({
          updated: [{ id: txn.id, version: version + 1 }],
        });
        const reported = await summary();
        expect(reported.statusCode, reported.payload).toBe(200);
        expect(reported.json()).toMatchObject({ income: usd(income) });
        await expectBalance(txn.accountId, future, '1234');
      }
    });

    it('sets and clears extraordinary through PATCH without changing balance', async () => {
      const txn = await createBookedIncome();
      for (const [extraordinary, version] of [
        [true, 1],
        [false, 2],
      ] as const) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/v1/transactions/${txn.id}`,
          headers: {
            ...balanceHeaders,
            'if-match': `"${version}"`,
            'idempotency-key': randomUUID(),
          },
          payload: { extraordinary },
        });
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.headers.etag).toBe(`"${version + 1}"`);
        expect(response.json()).toMatchObject({
          extraordinary,
          version: version + 1,
        });
      }
      await expectBalance(txn.accountId, future, '1234');
    });
  });

  function patchBooking(
    booking: Transaction,
    payload: UpdateTransactionCommand,
    key = randomUUID(),
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${booking.id}`,
      headers: {
        ...balanceHeaders,
        'idempotency-key': key,
        'if-match': `"${booking.version}"`,
      },
      payload,
    });
  }

  it('moves standalone confirmed income out of and back into its exact past balance cutoff', async () => {
    const booking = await createBookedIncome();
    await expectBalance(booking.accountId, past, '1234');
    const moved = await patchBooking(booking, { occurredAt: future });
    expect(moved.statusCode, moved.payload).toBe(200);
    expect(moved.headers.etag).toBe('"2"');
    const movedBooking = moved.json<Transaction>();
    expect(movedBooking).toMatchObject({
      id: booking.id,
      status: 'confirmed',
      occurredAt: future,
      amount: usd('1234'),
    });
    await expectBalance(booking.accountId, past, '0');
    await expectBalance(booking.accountId, future, '1234');

    const stale = await patchBooking(booking, { occurredAt: past });
    expect(stale.statusCode, stale.payload).toBe(412);
    expect(stale.json()).toMatchObject({
      title: 'Resource version mismatch',
      status: 412,
    });
    await expectBalance(booking.accountId, past, '0');

    const restored = await patchBooking(movedBooking, { occurredAt: past });
    expect(restored.statusCode, restored.payload).toBe(200);
    expect(restored.headers.etag).toBe('"3"');
    expect(restored.json()).toMatchObject({
      occurredAt: past,
      status: 'confirmed',
    });
    await expectBalance(booking.accountId, past, '1234');
    await expectBalance(booking.accountId, future, '1234');
  });

  it('moves standalone postings across balance buckets on status-only PATCH without counting a replay twice', async () => {
    const booking = await createBookedIncome();
    await expectBalance(booking.accountId, past, '1234');
    const key = randomUUID();
    const pending = await patchBooking(booking, { status: 'pending' }, key);
    expect(pending.statusCode, pending.payload).toBe(200);
    expect(pending.headers.etag).toBe('"2"');
    expect(pending.json()).toMatchObject({
      status: 'pending',
      occurredAt: past,
    });
    await expectBalance(booking.accountId, past, '0', '1234');
    const replay = await patchBooking(booking, { status: 'pending' }, key);
    expect(replay.statusCode, replay.payload).toBe(200);
    expect(replay.headers.etag).toBe('"2"');
    expect(replay.json()).toEqual(pending.json());
    await expectBalance(booking.accountId, past, '0', '1234');

    const draft = await patchBooking(pending.json<Transaction>(), {
      status: 'draft',
    });
    expect(draft.statusCode, draft.payload).toBe(200);
    expect(draft.headers.etag).toBe('"3"');
    expect(draft.json()).toMatchObject({ status: 'draft', occurredAt: past });
    await expectBalance(booking.accountId, past, '0');
  });

  // Reviewer strengthening for migration 0028 (mwtppw7z).
  it.each(['confirmed', 'pending'] as const)(
    'does not book an early reversal for a future %s transaction',
    async (status) => {
      const booking = await createBookedIncome();
      const moved = await patchBooking(booking, { occurredAt: future, status });
      expect(moved.statusCode, moved.payload).toBe(200);
      const current = moved.json<Transaction>();
      const voided = await app.inject({
        method: 'POST',
        url: `/v1/transactions/${current.id}/void`,
        headers: {
          ...balanceHeaders,
          'idempotency-key': randomUUID(),
          'if-match': `"${current.version}"`,
        },
        payload: { reason: 'Cancel the future income' },
      });
      expect(voided.statusCode, voided.payload).toBe(200);
      const balance = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${booking.accountId}/balance`,
        headers: balanceHeaders,
      });
      expect(balance.statusCode, balance.payload).toBe(200);
      expect(balance.json().nativeBalance).toEqual(usd('0'));
      const justBefore = new Date(Date.parse(future) - 1).toISOString();
      await expectBalance(booking.accountId, justBefore, '0', '0');
      await expectBalance(booking.accountId, future, '0', '0');
      const { rows } = await admin.query(
        `select status, occurred_at from public.ledger_postings
          where transaction_id = $1`,
        [booking.id],
      );
      expect(rows).toEqual(
        Array.from({ length: 4 }, () => ({
          status,
          occurred_at: new Date(future),
        })),
      );
    },
  );

  it('changes the fee header without changing its posting pair', async () => {
    const account = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
      payload: { name: 'Fee source', type: 'checking', currency: 'USD' },
    });
    expect(account.statusCode, account.payload).toBe(201);
    const source = account.json<{ id: string }>().id;

    const transfer = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { ...balanceHeaders, 'idempotency-key': randomUUID() },
      payload: {
        sourceAccountId: source,
        destinationAccountId: accountWorkspace2Id,
        amount: usd('130'),
        fee: usd('11'),
        occurredAt: past,
      },
    });
    expect(transfer.statusCode, transfer.payload).toBe(201);
    const { transactionId } = transfer.json<{ transactionId: string }>();
    const postings = async () =>
      (
        await admin.query(
          `select * from public.ledger_postings
            where transaction_id = $1 order by leg_kind`,
          [transactionId],
        )
      ).rows;

    const before = await postings();
    expect(before).toHaveLength(2);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/transactions/${transactionId}`,
      headers: {
        ...balanceHeaders,
        'idempotency-key': randomUUID(),
        'if-match': '"1"',
      },
      payload: { occurredAt: future, status: 'pending' },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect(patched.json()).toMatchObject({
      id: transactionId,
      occurredAt: future,
      status: 'pending',
      version: 2,
    });
    expect(await postings()).toEqual(before);
    await expect(
      transaction.run(subjectOwner, (client) =>
        client.query(
          `update public.ledger_postings set occurred_at = $2
            where transaction_id = $1`,
          [transactionId, future],
        ),
      ),
    ).rejects.toMatchObject({
      code: '42501',
      message: 'Ledger posting date is immutable',
    });
    expect(await postings()).toEqual(before);
    await expectBalance(source, past, '-141');
    await expectBalance(source, future, '-141');
  });

  it('preserves the past void response, replay, and exact balance cutoff', async () => {
    const booking = await createBookedIncome();
    await expectBalance(booking.accountId, past, '1234');
    const key = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/v1/transactions/${booking.id}/void`,
        headers: {
          ...balanceHeaders,
          'idempotency-key': key,
          'if-match': `"${booking.version}"`,
        },
        payload: { reason: 'Cancel the past income' },
      });
    const response = await send();
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.headers.etag).toBeUndefined();
    const { updatedAt } = response.json<Transaction>();
    expect(response.json()).toEqual({
      ...booking,
      status: 'voided',
      version: 2,
      updatedAt,
    });
    const replay = await send();
    expect(replay.statusCode, replay.payload).toBe(200);
    expect(replay.headers.etag).toBeUndefined();
    expect(replay.json()).toEqual(response.json());
    const justBeforeVoid = new Date(Date.parse(updatedAt) - 1).toISOString();
    await expectBalance(booking.accountId, justBeforeVoid, '1234');
    await expectBalance(booking.accountId, updatedAt, '0');
  });

  it('keeps direct standalone posting-date writes forbidden, even at the header date', async () => {
    // Simulate a pre-migration header/posting mismatch by inserting a pair
    // dated independently of its header in the existing seed workspace.
    await admin.query(
      `insert into public.ledger_postings
         (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
       values ($1, $2, $3, 'account', 14000, 'USD', 'confirmed', $4),
              ($1, $2, null, 'external', -14000, 'USD', 'confirmed', $4)`,
      [workspace2Id, txnWorkspace2Target, accountWorkspace2Id, future],
    );
    const readBalance = () =>
      app.inject({
        method: 'GET',
        url: `/v1/accounts/${accountWorkspace2Id}/balance?asOf=2026-08-20T10:00:00.000Z`,
        headers: balanceHeaders,
      });
    const before = await readBalance();
    expect(before.statusCode, before.payload).toBe(200);
    await expect(
      transaction.run(subjectOwner, (client) =>
        client.query(
          `update public.ledger_postings set occurred_at = '2026-08-20T10:00:00.000Z'
            where workspace_id = $1 and transaction_id = $2`,
          [workspace2Id, txnWorkspace2Target],
        ),
      ),
    ).rejects.toMatchObject({
      code: '42501',
      message: 'Ledger posting date is immutable',
    });
    const after = await readBalance();
    expect(after.statusCode, after.payload).toBe(200);
    expect(after.payload).toBe(before.payload);
  });

  it('200 happy path: a partial update changes only named fields, bumps version, refreshes updated_at, and preserves untouched fields', async () => {
    const key = '00000000-0000-4000-8000-000000000001';
    const command: UpdateTransactionCommand = {
      description: 'Owner Updated Description',
      notes: 'Updated notes',
      categoryId: category2Id,
      payeeId: payee2Id,
      tagIds: [tag2Id],
      status: 'pending',
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
      1,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.OK) {
      const updated = outcome.transaction;
      expect(updated.id).toBe(txnOwnerTarget);
      expect(updated.description).toBe('Owner Updated Description');
      expect(updated.notes).toBe('Updated notes');
      expect(updated.categoryId).toBe(category2Id);
      expect(updated.payeeId).toBe(payee2Id);
      expect(updated.tagIds).toEqual([tag2Id]);
      expect(updated.status).toBe('pending');
      expect(updated.version).toBe(2);
      expect(updated.amount.amountMinor).toBe('5000'); // untouched immutable amount preserved
      expect(updated.amount.currency).toBe('USD');
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(updated.createdAt).getTime(),
      );
    }

    // Direct database proof
    const dbRow = await admin.query(
      `select version, description, notes, category_id, payee_id, tag_ids, status, amount_minor from public.transactions where id = $1`,
      [txnOwnerTarget],
    );
    expect(dbRow.rows[0]).toMatchObject({
      version: 2,
      description: 'Owner Updated Description',
      notes: 'Updated notes',
      category_id: category2Id,
      payee_id: payee2Id,
      tag_ids: [tag2Id],
      status: 'pending',
      amount_minor: '5000',
    });
  });

  it('updates transaction by administrator', async () => {
    const key = '00000000-0000-4000-8000-000000000002';
    const command: UpdateTransactionCommand = {
      description: 'Admin Updated Description',
      status: 'confirmed',
    };

    const outcome = await service.update(
      subjectAdmin,
      workspace1Id,
      txnAdminTarget,
      command,
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.OK) {
      expect(outcome.transaction.description).toBe('Admin Updated Description');
      expect(outcome.transaction.status).toBe('confirmed');
      expect(outcome.transaction.version).toBe(2);
    }
  });

  it('updates transaction by editor', async () => {
    const key = '00000000-0000-4000-8000-000000000003';
    const command: UpdateTransactionCommand = {
      description: 'Editor Updated Description',
    };

    const outcome = await service.update(
      subjectEditor,
      workspace1Id,
      txnEditorTarget,
      command,
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.OK) {
      expect(outcome.transaction.description).toBe(
        'Editor Updated Description',
      );
      expect(outcome.transaction.version).toBe(2);
    }
  });

  it('412 proven by a CONCURRENT race: two simultaneous updates with same stale If-Match result in exactly one OK and one 412', async () => {
    const [res1, res2] = await Promise.all([
      service.update(
        subjectOwner,
        workspace1Id,
        txnRaceTarget,
        { description: 'Race Branch Alpha' },
        '00000000-0000-4000-8000-000000000004',
        1, // expected version 1
      ),
      service.update(
        subjectOwner,
        workspace1Id,
        txnRaceTarget,
        { description: 'Race Branch Beta' },
        '00000000-0000-4000-8000-000000000005',
        1, // expected version 1
      ),
    ]);

    const kinds = [res1.kind, res2.kind].sort();
    expect(kinds).toEqual([
      TRANSACTION_UPDATE_OUTCOMES.OK,
      TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT,
    ]);

    const winner =
      res1.kind === TRANSACTION_UPDATE_OUTCOMES.OK
        ? (res1 as TransactionUpdateOk)
        : (res2 as TransactionUpdateOk);
    expect(winner.transaction.version).toBe(2);

    // Database verification: version is exactly 2 and description matches the winner
    const dbRow = await admin.query(
      `select version, description from public.transactions where id = $1`,
      [txnRaceTarget],
    );
    expect(dbRow.rows[0]?.version).toBe(2);
    expect(['Race Branch Alpha', 'Race Branch Beta']).toContain(
      dbRow.rows[0]?.description,
    );
  });

  it('absent If-Match proceeds and increments version', async () => {
    const key = '00000000-0000-4000-8000-000000000006';
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnStaleTarget,
      { description: 'Absent If-Match Update' },
      key,
      undefined, // absent If-Match
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.OK) {
      expect(outcome.transaction.version).toBe(2);
      expect(outcome.transaction.description).toBe('Absent If-Match Update');
    }
  });

  it('stale If-Match returns VERSION_CONFLICT (412) with NO mutation in database', async () => {
    const key = '00000000-0000-4000-8000-000000000007';
    // txnStaleTarget is currently at version 2. Supplying version 1 must fail 412.
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnStaleTarget,
      { description: 'Stale Attempt' },
      key,
      1, // Stale version
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT);

    // Verify row in database is still at version 2 with previous description
    const dbRow = await admin.query(
      `select version, description from public.transactions where id = $1`,
      [txnStaleTarget],
    );
    expect(dbRow.rows[0]).toEqual({
      version: 2,
      description: 'Absent If-Match Update',
    });
  });

  it('Idempotency-Key replay with same key and body returns stored response and does not apply update twice', async () => {
    const key = '00000000-0000-4000-8000-000000000008';
    const command: UpdateTransactionCommand = {
      description: 'Idempotent Update',
    };

    // First call: writes update and returns OK with version 2
    const first = await service.update(
      subjectOwner,
      workspace1Id,
      txnIdempotencyTarget,
      command,
      key,
      1,
    );
    expect(first.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    if (first.kind === TRANSACTION_UPDATE_OUTCOMES.OK) {
      expect(first.transaction.version).toBe(2);
    }

    // Replay call: returns REPLAYED outcome with status 200, etag "2"
    const replay = await service.update(
      subjectOwner,
      workspace1Id,
      txnIdempotencyTarget,
      command,
      key,
      1,
    );
    expect(replay.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.REPLAYED);
    if (replay.kind === TRANSACTION_UPDATE_OUTCOMES.REPLAYED) {
      expect(replay.status).toBe(200);
      expect(replay.etag).toBe('"2"');
      expect((replay.body as { version: number }).version).toBe(2);
    }

    // DB row version must remain 2 (not bumped to 3)
    const dbRow = await admin.query(
      `select version from public.transactions where id = $1`,
      [txnIdempotencyTarget],
    );
    expect(dbRow.rows[0]?.version).toBe(2);
  });

  it('voided transaction cannot be updated: returns VOIDED outcome and makes no mutation in database', async () => {
    const key = '00000000-0000-4000-8000-000000000009';
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnVoidedTarget,
      { description: 'Attempt To Edit Voided' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.VOIDED);

    // Database verification: unchanged
    const dbRow = await admin.query(
      `select version, description, status from public.transactions where id = $1`,
      [txnVoidedTarget],
    );
    expect(dbRow.rows[0]).toMatchObject({
      version: 1,
      description: 'Voided Target',
      status: 'voided',
    });
  });

  it('reconciled transaction refuses field mutation: returns RECONCILED (409 stub) and makes no mutation in database', async () => {
    const key = '00000000-0000-4000-8000-000000000010';
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnReconciledTarget,
      { description: 'Attempt To Edit Reconciled' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.RECONCILED);

    // Database verification: unchanged
    const dbRow = await admin.query(
      `select version, description, status from public.transactions where id = $1`,
      [txnReconciledTarget],
    );
    expect(dbRow.rows[0]).toMatchObject({
      version: 1,
      description: 'Reconciled Target',
      status: 'reconciled',
    });
  });

  it('clears nullable fields with explicit null and writes NULL to PostgreSQL', async () => {
    const key = '00000000-0000-4000-8000-000000000011';
    const command: UpdateTransactionCommand = {
      description: null,
      notes: null,
      categoryId: null,
      payeeId: null,
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnNullableTarget,
      command,
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.OK) {
      expect(outcome.transaction.description).toBeNull();
      expect(outcome.transaction.notes).toBeNull();
      expect(outcome.transaction.categoryId).toBeNull();
      expect(outcome.transaction.payeeId).toBeNull();
      expect(outcome.transaction.version).toBe(2);
    }

    // Direct database proof
    const dbRow = await admin.query(
      `select description, notes, category_id, payee_id, version from public.transactions where id = $1`,
      [txnNullableTarget],
    );
    expect(dbRow.rows[0]).toEqual({
      description: null,
      notes: null,
      category_id: null,
      payee_id: null,
      version: 2,
    });
  });

  it('refuses access with FORBIDDEN (403) when actor is viewer and does not mutate row', async () => {
    const key = '00000000-0000-4000-8000-000000000012';
    const outcome = await service.update(
      subjectViewer,
      workspace1Id,
      txnOwnerTarget,
      { description: 'Viewer Attempt' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN);

    // Verify row in database is unchanged
    const dbRow = await admin.query(
      `select description from public.transactions where id = $1`,
      [txnOwnerTarget],
    );
    expect(dbRow.rows[0]?.description).not.toBe('Viewer Attempt');
  });

  it('refuses access with FORBIDDEN (403) when actor is non-member', async () => {
    const key = '00000000-0000-4000-8000-000000000013';
    const outcome = await service.update(
      subjectNonMember,
      workspace1Id,
      txnOwnerTarget,
      { description: 'Non-Member Attempt' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('refuses access with FORBIDDEN (403) when workspace does not exist', async () => {
    const key = '00000000-0000-4000-8000-000000000014';
    const outcome = await service.update(
      subjectOwner,
      absentWorkspaceId,
      txnOwnerTarget,
      { description: 'Absent WS' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN);
  });

  it('returns NOT_FOUND (404) when transaction does not exist in workspace', async () => {
    const key = '00000000-0000-4000-8000-000000000015';
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      absentTxnId,
      { description: 'Absent Txn' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND);
  });

  it('returns NOT_FOUND (404, never 403) when transaction belongs to a different workspace (scoping proof)', async () => {
    const key = '00000000-0000-4000-8000-000000000016';
    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnWorkspace2Target,
      { description: 'Cross Workspace Exploit' },
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND);

    // Verify workspace 2 row was not touched
    const dbRow = await admin.query(
      `select description from public.transactions where id = $1`,
      [txnWorkspace2Target],
    );
    expect(dbRow.rows[0]?.description).toBe('Workspace 2 Target');
  });

  it('pins authorization ahead of idempotency read: refuses 403 without replaying when matching idempotency record exists for viewer', async () => {
    const key = '00000000-0000-4000-8000-000000000017';
    const command: UpdateTransactionCommand = {
      description: 'Viewer Replay Leak Check',
    };
    const fingerprint = computeRequestFingerprint({
      transactionId: txnOwnerTarget,
      ...command,
    });

    // Seed a 200 response in idempotency store
    await idempotencyAdapter.write(
      admin,
      subjectViewer,
      'PATCH /v1/transactions/{transactionId}',
      key,
      fingerprint,
      200,
      '"2"',
      { id: txnOwnerTarget, description: 'Secret Leaked Data', version: 2 },
      workspace1Id,
    );

    const outcome = await service.update(
      subjectViewer,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN);
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
  });

  it('pins authorization ahead of idempotency read: refuses 403 without replaying when matching idempotency record exists for non-member', async () => {
    const key = '00000000-0000-4000-8000-000000000018';
    const command: UpdateTransactionCommand = {
      description: 'Non-Member Replay Leak Check',
    };
    const fingerprint = computeRequestFingerprint({
      transactionId: txnOwnerTarget,
      ...command,
    });

    // Seed a 200 response in idempotency store
    await idempotencyAdapter.write(
      admin,
      subjectNonMember,
      'PATCH /v1/transactions/{transactionId}',
      key,
      fingerprint,
      200,
      '"2"',
      { id: txnOwnerTarget, description: 'Secret Leaked Data', version: 2 },
      workspace1Id,
    );

    const outcome = await service.update(
      subjectNonMember,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );

    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN);
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
  });

  it('update with cross-workspace category_id returns CATEGORY_NOT_FOUND outcome (422) and leaves transaction UNCHANGED', async () => {
    const key = '00000000-0000-4000-8000-000000000019';
    const initialTxn = await admin.query<{
      category_id: string | null;
      version: number;
    }>('select category_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    const initialCat = initialTxn.rows[0].category_id;
    const initialVer = initialTxn.rows[0].version;

    const command: UpdateTransactionCommand = {
      categoryId: categoryWs2Id, // Real row in Workspace 2
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.CATEGORY_NOT_FOUND);

    const stored = await admin.query<{
      category_id: string | null;
      version: number;
    }>('select category_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    expect(stored.rows[0].category_id).toBe(initialCat);
    expect(stored.rows[0].version).toBe(initialVer);
  });

  it('update with nonexistent category_id returns identical CATEGORY_NOT_FOUND outcome (422) and leaves transaction UNCHANGED', async () => {
    const key = '00000000-0000-4000-8000-000000000020';
    const initialTxn = await admin.query<{
      category_id: string | null;
      version: number;
    }>('select category_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    const initialCat = initialTxn.rows[0].category_id;
    const initialVer = initialTxn.rows[0].version;

    const command: UpdateTransactionCommand = {
      categoryId: absentCategoryId,
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.CATEGORY_NOT_FOUND);

    const stored = await admin.query<{
      category_id: string | null;
      version: number;
    }>('select category_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    expect(stored.rows[0].category_id).toBe(initialCat);
    expect(stored.rows[0].version).toBe(initialVer);
  });

  it('update with cross-workspace payee_id returns PAYEE_NOT_FOUND outcome (422) and leaves transaction UNCHANGED', async () => {
    const key = '00000000-0000-4000-8000-000000000021';
    const initialTxn = await admin.query<{
      payee_id: string | null;
      version: number;
    }>('select payee_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    const initialPayee = initialTxn.rows[0].payee_id;
    const initialVer = initialTxn.rows[0].version;

    const command: UpdateTransactionCommand = {
      payeeId: payeeWs2Id, // Real row in Workspace 2
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.PAYEE_NOT_FOUND);

    const stored = await admin.query<{
      payee_id: string | null;
      version: number;
    }>('select payee_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    expect(stored.rows[0].payee_id).toBe(initialPayee);
    expect(stored.rows[0].version).toBe(initialVer);
  });

  it('update with nonexistent payee_id returns identical PAYEE_NOT_FOUND outcome (422) and leaves transaction UNCHANGED', async () => {
    const key = '00000000-0000-4000-8000-000000000022';
    const initialTxn = await admin.query<{
      payee_id: string | null;
      version: number;
    }>('select payee_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    const initialPayee = initialTxn.rows[0].payee_id;
    const initialVer = initialTxn.rows[0].version;

    const command: UpdateTransactionCommand = {
      payeeId: absentPayeeId,
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.PAYEE_NOT_FOUND);

    const stored = await admin.query<{
      payee_id: string | null;
      version: number;
    }>('select payee_id, version from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    expect(stored.rows[0].payee_id).toBe(initialPayee);
    expect(stored.rows[0].version).toBe(initialVer);
  });

  it('positive control: update with legitimate same-workspace category_id and payee_id succeeds (200 OK)', async () => {
    const key = '00000000-0000-4000-8000-000000000023';
    const command: UpdateTransactionCommand = {
      categoryId: category2Id,
      payeeId: payee2Id,
    };

    const outcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.OK);
    const updated = (outcome as TransactionUpdateOk).transaction;
    expect(updated.categoryId).toBe(category2Id);
    expect(updated.payeeId).toBe(payee2Id);

    const stored = await admin.query<{
      category_id: string | null;
      payee_id: string | null;
    }>('select category_id, payee_id from public.transactions where id = $1', [
      txnOwnerTarget,
    ]);
    expect(stored.rows[0].category_id).toBe(category2Id);
    expect(stored.rows[0].payee_id).toBe(payee2Id);
  });

  it('404 vs 422 distinction: update on absent transaction returns NOT_FOUND (404), while invalid catalog reference returns CATEGORY_NOT_FOUND (422)', async () => {
    const key1 = '00000000-0000-4000-8000-000000000024';
    const key2 = '00000000-0000-4000-8000-000000000025';

    // 1. Absent transaction -> 404
    const absentOutcome = await service.update(
      subjectOwner,
      workspace1Id,
      absentTxnId,
      { categoryId: categoryWs2Id },
      key1,
    );
    expect(absentOutcome.kind).toBe(TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND);

    // 2. Existing transaction + absent category -> 422
    const badCatOutcome = await service.update(
      subjectOwner,
      workspace1Id,
      txnOwnerTarget,
      { categoryId: categoryWs2Id },
      key2,
    );
    expect(badCatOutcome.kind).toBe(
      TRANSACTION_UPDATE_OUTCOMES.CATEGORY_NOT_FOUND,
    );
  });

  it('unrelated 23503 control: adapter.updateTransaction with unmapped 23503 re-throws raw error untouched', async () => {
    const adapter = new PostgresTransactionAdapter();
    // Simulate an unmapped FK violation by mocking client query
    const client: TransactionClient = {
      query: async () => {
        throw {
          code: '23503',
          constraint: 'transactions_workspace_id_fkey',
        };
      },
    };

    await expect(
      adapter.updateTransaction(client, workspace1Id, txnOwnerTarget, {
        description: 'Test',
      }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'transactions_workspace_id_fkey',
    });
  });
});
