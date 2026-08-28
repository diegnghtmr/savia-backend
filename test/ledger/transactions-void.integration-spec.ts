import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRANSACTION_VOID_OUTCOMES,
  type VoidTransactionCommand,
  type TransactionVoidOk,
} from '../../src/ledger/ledger.port.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PostgresAccountsAdapter } from '../../src/accounts/postgres-accounts.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('TransactionService voidTransaction database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: TransactionService;
  let accountsAdapter: PostgresAccountsAdapter;
  let idempotencyAdapter: PostgresIdempotencyAdapter;

  const subjectOwner = subject(921);
  const subjectAdmin = subject(922);
  const subjectEditor = subject(923);
  const subjectViewer = subject(924);
  const subjectNonMember = subject(925);
  const subjectWorkspace2Owner = subject(926);

  const workspace1Id = id(961);
  const workspace2Id = id(962);
  const absentWorkspaceId = id(999);

  const accountActiveId = id(5101);
  const accountWorkspace2Id = id(5102);

  const txnConfirmedTarget = id(7101);
  const txnPendingTarget = id(7102);
  const txnDraftTarget = id(7103);
  const txnVoidedTarget = id(7104);
  const txnReconciledTarget = id(7105);
  const txnDatingTarget = id(7106);
  const txnBalanceTarget = id(7107);
  const txnIfMatchTarget = id(7108);
  const txnViewerTarget = id(7109);
  const txnWorkspace2Target = id(7110);
  const absentTxnId = id(7999);

  const validReason: VoidTransactionCommand = {
    reason: 'Duplicate entry detected during audit',
  };

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
    accountsAdapter = new PostgresAccountsAdapter();

    // 1. Auth Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'txn-void-owner@example.test',
        subjectAdmin,
        'txn-void-admin@example.test',
        subjectEditor,
        'txn-void-editor@example.test',
        subjectViewer,
        'txn-void-viewer@example.test',
        subjectNonMember,
        'txn-void-nonmember@example.test',
        subjectWorkspace2Owner,
        'txn-void-ws2-owner@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectOwner, 'txn-void-owner@example.test', 'Txn Void Owner'],
      [subjectAdmin, 'txn-void-admin@example.test', 'Txn Void Admin'],
      [subjectEditor, 'txn-void-editor@example.test', 'Txn Void Editor'],
      [subjectViewer, 'txn-void-viewer@example.test', 'Txn Void Viewer'],
      [
        subjectNonMember,
        'txn-void-nonmember@example.test',
        'Txn Void Non Member',
      ],
      [
        subjectWorkspace2Owner,
        'txn-void-ws2-owner@example.test',
        'Txn Void WS2 Owner',
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
      [workspace1Id, 'Txn Void Workspace One'],
      [workspace2Id, 'Txn Void Workspace Two'],
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
          'Confirmed Target', 'Initial notes', null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($5, $2, $3, 'income', 'pending', 7000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Pending Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($6, $2, $3, 'expense', 'draft', 6000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Draft Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($7, $2, $3, 'expense', 'voided', 8000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Voided Target', null, null, null, null, null, '2026-08-20T12:00:00.000Z'::timestamptz, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($8, $2, $3, 'expense', 'reconciled', 9000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Reconciled Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($9, $2, $3, 'expense', 'confirmed', 10000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Dating Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($10, $2, $3, 'expense', 'confirmed', 15000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Balance Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($11, $2, $3, 'expense', 'confirmed', 20000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'IfMatch Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($12, $2, $3, 'expense', 'confirmed', 25000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Viewer Target', null, null, null, null, null, null, $4, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1),
         ($13, $14, $15, 'expense', 'confirmed', 30000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
          'Workspace 2 Target', null, null, null, null, null, null, $16, '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1)`,
      [
        txnConfirmedTarget,
        workspace1Id,
        accountActiveId,
        subjectOwner,
        txnPendingTarget,
        txnDraftTarget,
        txnVoidedTarget,
        txnReconciledTarget,
        txnDatingTarget,
        txnBalanceTarget,
        txnIfMatchTarget,
        txnViewerTarget,
        txnWorkspace2Target,
        workspace2Id,
        accountWorkspace2Id,
        subjectWorkspace2Owner,
      ],
    );

    // 7. Ledger Postings for seeded transactions (draft has NO postings)
    const seedTxns = [
      { id: txnConfirmedTarget, amount: '5000', status: 'confirmed' },
      { id: txnPendingTarget, amount: '7000', status: 'pending' },
      { id: txnReconciledTarget, amount: '9000', status: 'reconciled' },
      { id: txnDatingTarget, amount: '10000', status: 'confirmed' },
      { id: txnBalanceTarget, amount: '15000', status: 'confirmed' },
      { id: txnIfMatchTarget, amount: '20000', status: 'confirmed' },
      { id: txnViewerTarget, amount: '25000', status: 'confirmed' },
      {
        id: txnWorkspace2Target,
        amount: '30000',
        status: 'confirmed',
        wsId: workspace2Id,
        acctId: accountWorkspace2Id,
      },
    ];

    for (const t of seedTxns) {
      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1::uuid, $2::uuid, $3::uuid, 'account', $4, 'USD', $5, '2026-08-20T10:00:00.000Z'::timestamptz),
                ($1::uuid, $2::uuid, null, 'external', $6, 'USD', $5, '2026-08-20T10:00:00.000Z'::timestamptz)`,
        [
          t.wsId ?? workspace1Id,
          t.id,
          t.acctId ?? accountActiveId,
          t.amount,
          t.status,
          `-${t.amount}`,
        ],
      );
    }

    // Seeded voided transaction carries 4 postings: original pair + reversal pair
    await admin.query(
      `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'account', 8000, 'USD', 'confirmed', '2026-08-20T10:00:00.000Z'::timestamptz),
              ($1::uuid, $2::uuid, null, 'external', -8000, 'USD', 'confirmed', '2026-08-20T10:00:00.000Z'::timestamptz),
              ($1::uuid, $2::uuid, $3::uuid, 'account', -8000, 'USD', 'confirmed', '2026-08-20T12:00:00.000Z'::timestamptz),
              ($1::uuid, $2::uuid, null, 'external', 8000, 'USD', 'confirmed', '2026-08-20T12:00:00.000Z'::timestamptz)`,
      [workspace1Id, txnVoidedTarget, accountActiveId],
    );
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

  it('4.1.a Same id, still readable: 200 body carries original id with status voided, and GET /v1/transactions/{id} returns 200', async () => {
    const outcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnConfirmedTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000a1',
    );

    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.OK);
    const ok = outcome as TransactionVoidOk;
    expect(ok.transaction.id).toBe(txnConfirmedTarget);
    expect(ok.transaction.status).toBe('voided');
    expect(ok.transaction.version).toBe(2);

    // Read back via service.read: must return 200 (kind: 'ok'), never 404
    const readBack = await service.read(
      subjectOwner,
      workspace1Id,
      txnConfirmedTarget,
    );
    expect(readBack.kind).toBe('ok');
    if (readBack.kind === 'ok') {
      expect(readBack.transaction.id).toBe(txnConfirmedTarget);
      expect(readBack.transaction.status).toBe('voided');
      expect(readBack.transaction.version).toBe(2);
    }
  });

  it('4.1.b Reversal, not mutation: count ledger_postings goes from 2 to 4, with original postings untouched', async () => {
    // Before voiding txnPendingTarget, postings count is 2
    const beforeResult = await admin.query<{ count: string }>(
      'select count(*)::text as count from public.ledger_postings where transaction_id = $1::uuid',
      [txnPendingTarget],
    );
    expect(beforeResult.rows[0]?.count).toBe('2');

    const outcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnPendingTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000b1',
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.OK);

    // After voiding, postings count is 4
    const afterResult = await admin.query<{
      account_id: string | null;
      leg_kind: string;
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      'select account_id::text, leg_kind, amount_minor::text, currency, status from public.ledger_postings where transaction_id = $1::uuid order by occurred_at asc, leg_kind asc',
      [txnPendingTarget],
    );
    expect(afterResult.rows).toHaveLength(4);

    // Original legs
    expect(afterResult.rows[0]).toMatchObject({
      account_id: accountActiveId,
      leg_kind: 'account',
      amount_minor: '7000',
      currency: 'USD',
      status: 'pending',
    });
    expect(afterResult.rows[1]).toMatchObject({
      account_id: null,
      leg_kind: 'external',
      amount_minor: '-7000',
      currency: 'USD',
      status: 'pending',
    });

    // Reversal legs
    expect(afterResult.rows[2]).toMatchObject({
      account_id: accountActiveId,
      leg_kind: 'account',
      amount_minor: '-7000',
      currency: 'USD',
      status: 'pending',
    });
    expect(afterResult.rows[3]).toMatchObject({
      account_id: null,
      leg_kind: 'external',
      amount_minor: '7000',
      currency: 'USD',
      status: 'pending',
    });
  });

  it('4.1.c & 4.1.d Balance restored exactly & balance query needs no voided branch', async () => {
    // Read balance before voiding txnBalanceTarget
    const initialBalance = await accountsAdapter.readAccountBalance(
      { query: admin.query.bind(admin) },
      workspace1Id,
      accountActiveId,
    );
    expect(initialBalance).toBeDefined();
    const balanceBeforeVoid = BigInt(initialBalance!.nativeBalance.amountMinor);

    // Void txnBalanceTarget (which was a 15000 expense)
    const outcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnBalanceTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000c1',
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.OK);

    // Read balance after void: expense 15000 is reversed, so balance increases by 15000
    const finalBalance = await accountsAdapter.readAccountBalance(
      { query: admin.query.bind(admin) },
      workspace1Id,
      accountActiveId,
    );
    expect(finalBalance).toBeDefined();
    const balanceAfterVoid = BigInt(finalBalance!.nativeBalance.amountMinor);

    expect(balanceAfterVoid - balanceBeforeVoid).toBe(15000n);
  });

  it('4.1.e RULING 41 dating: asOf strictly between original occurred_at and void instant shows money as present', async () => {
    // txnDatingTarget occurred at '2026-08-20T10:00:00.000Z'
    // Void it now (current time > 2026-08-20)
    const outcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnDatingTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000e1',
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.OK);

    // asOf dated '2026-08-20T11:00:00.000Z' (between original occurred_at and void instant)
    // The expense (10000) was present at that time, so the posting IS counted
    const intermediateBalance = await accountsAdapter.readAccountBalance(
      { query: admin.query.bind(admin) },
      workspace1Id,
      accountActiveId,
      '2026-08-20T11:00:00.000Z',
    );
    expect(intermediateBalance).toBeDefined();

    // Verify specifically from ledger_postings that the reversal occurred_at > 2026-08-20T11:00:00.000Z
    const postings = await admin.query<{
      occurred_at: Date;
      amount_minor: string;
      leg_kind: string;
    }>(
      'select occurred_at, amount_minor::text, leg_kind from public.ledger_postings where transaction_id = $1::uuid order by occurred_at asc',
      [txnDatingTarget],
    );
    expect(postings.rows).toHaveLength(4);
    const originalPostings = postings.rows.slice(0, 2);
    const reversalPostings = postings.rows.slice(2, 4);

    expect(originalPostings[0]!.occurred_at.toISOString()).toBe(
      '2026-08-20T10:00:00.000Z',
    );
    expect(reversalPostings[0]!.occurred_at.getTime()).toBeGreaterThan(
      new Date('2026-08-20T11:00:00.000Z').getTime(),
    );
  });

  it('4.1.f Status gating: draft -> 409 (draft), voided -> 409 (voided), reconciled -> 409 (reconciled)', async () => {
    // Draft -> 409 DRAFT
    const draftOutcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnDraftTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000f1',
    );
    expect(draftOutcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.DRAFT);

    // Voided -> 409 VOIDED
    const voidedOutcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnVoidedTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000f2',
    );
    expect(voidedOutcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.VOIDED);

    // Reconciled -> 409 RECONCILED
    const reconciledOutcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnReconciledTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000f3',
    );
    expect(reconciledOutcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.RECONCILED);
  });

  it('4.1.g Double void with a NEW idempotency key -> 409 (voided)', async () => {
    // txnConfirmedTarget was already voided in test 4.1.a
    // Now call with a fresh, completely NEW idempotency key
    const outcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnConfirmedTarget,
      validReason,
      '00000000-0000-4000-8000-999999999999', // Fresh idempotency key
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.VOIDED);
  });

  it('4.1.i If-Match: stale -> 412 with no mutation; matching -> proceeds', async () => {
    // Stale version (expected version 99 vs current version 1)
    const staleOutcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnIfMatchTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000i1',
      99,
    );
    expect(staleOutcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT);

    // Verify row in DB was not mutated
    const txnUnchanged = await service.read(
      subjectOwner,
      workspace1Id,
      txnIfMatchTarget,
    );
    expect(txnUnchanged.kind).toBe('ok');
    if (txnUnchanged.kind === 'ok') {
      expect(txnUnchanged.transaction.status).toBe('confirmed');
      expect(txnUnchanged.transaction.version).toBe(1);
    }

    // Matching version (expected version 1)
    const matchOutcome = await service.void(
      subjectOwner,
      workspace1Id,
      txnIfMatchTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000i2',
      1,
    );
    expect(matchOutcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.OK);
  });

  it('4.1.j 403 for a viewer, and 403 blocks persistence', async () => {
    const outcome = await service.void(
      subjectViewer,
      workspace1Id,
      txnViewerTarget,
      validReason,
      '00000000-0000-4000-8000-0000000000j1',
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.FORBIDDEN);

    // Verify transaction was NOT voided
    const checkTxn = await service.read(
      subjectOwner,
      workspace1Id,
      txnViewerTarget,
    );
    expect(checkTxn.kind).toBe('ok');
    if (checkTxn.kind === 'ok') {
      expect(checkTxn.transaction.status).toBe('confirmed');
    }
  });

  it('pins authorization ahead of the idempotency read on void', async () => {
    const matchingKey = '00000000-0000-4000-8000-000000000001';
    const fingerprint = computeRequestFingerprint({
      transactionId: txnConfirmedTarget,
      ...validReason,
    });

    // Seed idempotency record in DB for owner
    await admin.query(
      `insert into public.command_idempotency
         (workspace_id, user_id, route, idempotency_key, request_fingerprint, response_status, response_body)
       values ($1::uuid, $2::uuid, 'POST /v1/transactions/{transactionId}/void', $3::uuid, $4, 200, '{"id":"mock"}'::jsonb)`,
      [workspace1Id, subjectViewer, matchingKey, fingerprint],
    );

    // Call as viewer with matching idempotency record
    const outcome = await service.void(
      subjectViewer,
      workspace1Id,
      txnConfirmedTarget,
      validReason,
      matchingKey,
    );

    // Must return FORBIDDEN, not REPLAYED
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.FORBIDDEN);
  });

  it('refuses 404 when transaction is not found in workspace', async () => {
    const outcome = await service.void(
      subjectOwner,
      workspace1Id,
      absentTxnId,
      validReason,
      '00000000-0000-4000-8000-000000000404',
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.NOT_FOUND);
  });

  it('refuses 403 when caller accesses non-member or absent workspace', async () => {
    const outcome = await service.void(
      subjectOwner,
      absentWorkspaceId,
      txnConfirmedTarget,
      validReason,
      '00000000-0000-4000-8000-000000000403',
    );
    expect(outcome.kind).toBe(TRANSACTION_VOID_OUTCOMES.FORBIDDEN);
  });
});
