import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRANSACTION_UPDATE_OUTCOMES,
  type UpdateTransactionCommand,
  type TransactionUpdateOk,
} from '../../src/ledger/ledger.port.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

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
  const payee1Id = id(8101);
  const payee2Id = id(8102);
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
    service = new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      new PostgresIdempotencyAdapter(),
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
  });

  afterAll(async () => {
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

  it('voided transaction cannot be updated: returns VOIDED (403) and makes no mutation in database', async () => {
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
});
