import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_BALANCE_OUTCOMES,
  ACCOUNT_CLOSE_OUTCOMES,
  ACCOUNT_READ_OUTCOMES,
  type AccountCloseReplayed,
  type AccountReadOk,
} from '../../src/accounts/accounts.port.js';
import { AccountsService } from '../../src/accounts/accounts.service.js';
import { PostgresAccountsAdapter } from '../../src/accounts/postgres-accounts.adapter.js';
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

describe('AccountsService closeAccount database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: AccountsService;
  let adapter: PostgresAccountsAdapter;

  const subjectOwner = subject(821);
  const subjectAdmin = subject(822);
  const subjectEditor = subject(823);
  const subjectViewer = subject(824);
  const subjectNonMember = subject(825);

  const workspace1Id = id(871);
  const workspace2Id = id(872);
  const absentWorkspaceId = id(899);

  const accountNonZeroBalanceId = id(5001);
  const accountDraftTxnId = id(5002);
  const accountPendingTxnId = id(5003);
  const accountConfirmedOnlyId = id(5004);
  const accountReadableAfterCloseId = id(5005);
  const accountIdempotencyId = id(5006);
  const accountIfMatchId = id(5007);
  const accountAlreadyClosedId = id(5008);
  const accountForeignWorkspaceId = id(5009);
  const absentAccountId = id(5999);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    adapter = new PostgresAccountsAdapter();
    service = new AccountsService(
      transaction,
      adapter,
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
      [
        subjectOwner,
        'close-owner@example.test',
        subjectAdmin,
        'close-admin@example.test',
        subjectEditor,
        'close-editor@example.test',
        subjectViewer,
        'close-viewer@example.test',
        subjectNonMember,
        'close-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'close-owner@example.test', 'Close Owner'],
      [subjectAdmin, 'close-admin@example.test', 'Close Admin'],
      [subjectEditor, 'close-editor@example.test', 'Close Editor'],
      [subjectViewer, 'close-viewer@example.test', 'Close Viewer'],
      [subjectNonMember, 'close-nonmember@example.test', 'Close Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Close Workspace One'],
      [workspace2Id, 'Close Workspace Two'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [wsId, name],
      );
    }

    // 3. Memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'administrator', 'active'),
              ($1, $4, 'editor', 'active'),
              ($1, $5, 'viewer', 'active'),
              ($6, $2, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        workspace2Id,
      ],
    );

    // 4. Accounts
    await admin.query(
      `insert into public.accounts
         (id, workspace_id, name, type, currency, status, include_in_net_worth, created_by, created_at, updated_at, version, closed_at)
       values
         ($1, $2, 'Non-Zero Balance Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($4, $2, 'Draft Txn Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($5, $2, 'Pending Txn Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($6, $2, 'Confirmed Only Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($7, $2, 'Readable After Close Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($8, $2, 'Idempotency Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($9, $2, 'IfMatch Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null),
         ($10, $2, 'Already Closed Account', 'checking', 'USD', 'closed', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, '2026-07-01T00:00:00.000Z'::timestamptz),
         ($11, $12, 'Foreign WS2 Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1, null)`,
      [
        accountNonZeroBalanceId,
        workspace1Id,
        subjectOwner,
        accountDraftTxnId,
        accountPendingTxnId,
        accountConfirmedOnlyId,
        accountReadableAfterCloseId,
        accountIdempotencyId,
        accountIfMatchId,
        accountAlreadyClosedId,
        accountForeignWorkspaceId,
        workspace2Id,
      ],
    );

    // Helper to seed transactions and ledger postings
    const seedPosting = async (
      txnId: string,
      accId: string,
      wsId: string,
      status: 'draft' | 'pending' | 'confirmed' | 'reconciled',
      amountMinor: string,
      occurredAt: string,
    ) => {
      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, description, created_by)
         values ($1::uuid, $2::uuid, $3::uuid, 'adjustment', $4, $5, 'USD', $6::timestamptz, 'Seed transaction', $7::uuid)`,
        [txnId, wsId, accId, status, amountMinor, occurredAt, subjectOwner],
      );

      const negAmount = amountMinor.startsWith('-')
        ? amountMinor.slice(1)
        : `-${amountMinor}`;

      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values
           ($1::uuid, $2::uuid, $3::uuid, 'account', $4, 'USD', $5, $6::timestamptz),
           ($1::uuid, $2::uuid, null, 'external', $7, 'USD', $5, $6::timestamptz)`,
        [wsId, txnId, accId, amountMinor, status, occurredAt, negAmount],
      );
    };

    // Account 1: Non-zero balance (confirmed postings = 50000), zero draft/pending
    await seedPosting(
      id(6001),
      accountNonZeroBalanceId,
      workspace1Id,
      'confirmed',
      '50000',
      '2026-07-01T12:00:00.000Z',
    );

    // Account 2: Draft transaction
    await seedPosting(
      id(6002),
      accountDraftTxnId,
      workspace1Id,
      'draft',
      '1000',
      '2026-07-01T12:00:00.000Z',
    );

    // Account 3: Pending transaction
    await seedPosting(
      id(6003),
      accountPendingTxnId,
      workspace1Id,
      'pending',
      '2000',
      '2026-07-01T12:00:00.000Z',
    );

    // Account 4: Confirmed and reconciled transactions only
    await seedPosting(
      id(6004),
      accountConfirmedOnlyId,
      workspace1Id,
      'confirmed',
      '3000',
      '2026-07-01T12:00:00.000Z',
    );
    await seedPosting(
      id(6005),
      accountConfirmedOnlyId,
      workspace1Id,
      'reconciled',
      '4000',
      '2026-07-02T12:00:00.000Z',
    );

    // Account 5: For readable after close test (seed confirmed balance = 75000)
    await seedPosting(
      id(6006),
      accountReadableAfterCloseId,
      workspace1Id,
      'confirmed',
      '75000',
      '2026-07-01T12:00:00.000Z',
    );
  });

  afterAll(async () => {
    await admin.end();
    await pool.end();
  });

  it('a. RULING 30 negative case: closes account with non-zero balance and zero draft/pending transactions, asserting readAccountBalance is NEVER invoked', async () => {
    const balanceSpy = vi.spyOn(adapter, 'readAccountBalance');

    const outcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountNonZeroBalanceId,
      id(7001),
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.OK);
    if (outcome.kind !== ACCOUNT_CLOSE_OUTCOMES.OK) return;

    expect(outcome.account.id).toBe(accountNonZeroBalanceId);
    expect(outcome.account.status).toBe('closed');
    expect(outcome.account.version).toBe(2);

    // Proves balance dependency was never invoked on this code path
    expect(balanceSpy).not.toHaveBeenCalled();

    // Verify DB row
    const dbRow = await admin.query(
      'select status, closed_at, version from public.accounts where id = $1::uuid',
      [accountNonZeroBalanceId],
    );
    expect(dbRow.rows[0].status).toBe('closed');
    expect(dbRow.rows[0].closed_at).not.toBeNull();
    expect(dbRow.rows[0].version).toBe(2);
  });

  it('b. positive case: refuses closure when draft transaction exists (409) and when pending transaction exists (409)', async () => {
    // Draft txn -> has_unsettled_transactions
    const outcomeDraft = await service.close(
      subjectOwner,
      workspace1Id,
      accountDraftTxnId,
      id(7002),
    );
    expect(outcomeDraft.kind).toBe(
      ACCOUNT_CLOSE_OUTCOMES.HAS_UNSETTLED_TRANSACTIONS,
    );

    // Pending txn -> has_unsettled_transactions
    const outcomePending = await service.close(
      subjectOwner,
      workspace1Id,
      accountPendingTxnId,
      id(7003),
    );
    expect(outcomePending.kind).toBe(
      ACCOUNT_CLOSE_OUTCOMES.HAS_UNSETTLED_TRANSACTIONS,
    );

    // Both accounts remain active in DB
    const rows = await admin.query(
      'select id, status from public.accounts where id in ($1::uuid, $2::uuid)',
      [accountDraftTxnId, accountPendingTxnId],
    );
    expect(rows.rows.every((r) => r.status === 'active')).toBe(true);
  });

  it('c. confirmed-only case: closes account with confirmed and reconciled transactions with 200', async () => {
    const outcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountConfirmedOnlyId,
      id(7004),
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.OK);
    if (outcome.kind !== ACCOUNT_CLOSE_OUTCOMES.OK) return;

    expect(outcome.account.status).toBe('closed');
    expect(outcome.account.version).toBe(2);
  });

  it('d. readable after close: account and balance remain readable via GET after closure', async () => {
    const closeOutcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountReadableAfterCloseId,
      id(7005),
    );
    expect(closeOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.OK);

    // GET /v1/accounts/{accountId} returns 200 with closed account
    const readOutcome = await service.read(
      subjectOwner,
      workspace1Id,
      accountReadableAfterCloseId,
    );
    expect(readOutcome.kind).toBe(ACCOUNT_READ_OUTCOMES.OK);
    expect((readOutcome as AccountReadOk).account.status).toBe('closed');

    // GET /v1/accounts/{accountId}/balance returns 200 with valid balance
    const balanceOutcome = await service.readBalance(
      subjectOwner,
      workspace1Id,
      accountReadableAfterCloseId,
    );
    expect(balanceOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
  });

  it('e. idempotency: replay returns stored response and does not close twice', async () => {
    const idempotencyKey = id(7006);

    const first = await service.close(
      subjectOwner,
      workspace1Id,
      accountIdempotencyId,
      idempotencyKey,
    );
    expect(first.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.OK);
    if (first.kind !== ACCOUNT_CLOSE_OUTCOMES.OK) return;

    const second = await service.close(
      subjectOwner,
      workspace1Id,
      accountIdempotencyId,
      idempotencyKey,
    );
    expect(second.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.REPLAYED);
    const replayed = second as AccountCloseReplayed;
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(first.account);

    // Version remains 2 (not incremented twice)
    const row = await admin.query(
      'select version, status from public.accounts where id = $1::uuid',
      [accountIdempotencyId],
    );
    expect(row.rows[0].version).toBe(2);
    expect(row.rows[0].status).toBe('closed');
  });

  it('f. If-Match: stale If-Match -> 412 (version_conflict) without mutation; matching -> 200; absent -> 200', async () => {
    // 1. Stale If-Match (version 99 vs current 1)
    const staleOutcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountIfMatchId,
      id(7007),
      99,
    );
    expect(staleOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.VERSION_CONFLICT);

    // Verify account was NOT mutated
    const unmutated = await admin.query(
      'select version, status from public.accounts where id = $1::uuid',
      [accountIfMatchId],
    );
    expect(unmutated.rows[0].version).toBe(1);
    expect(unmutated.rows[0].status).toBe('active');

    // 2. Matching If-Match (version 1)
    const matchingOutcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountIfMatchId,
      id(7008),
      1,
    );
    expect(matchingOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.OK);
    if (matchingOutcome.kind !== ACCOUNT_CLOSE_OUTCOMES.OK) return;
    expect(matchingOutcome.account.status).toBe('closed');
    expect(matchingOutcome.account.version).toBe(2);
  });

  it('g. authorization: viewer -> 403, non-member -> 403, absent workspace -> 403, foreign account -> 404', async () => {
    // Viewer -> 403
    const viewerOutcome = await service.close(
      subjectViewer,
      workspace1Id,
      accountNonZeroBalanceId,
      id(7009),
    );
    expect(viewerOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.FORBIDDEN);

    // Non-member -> 403
    const nonMemberOutcome = await service.close(
      subjectNonMember,
      workspace1Id,
      accountNonZeroBalanceId,
      id(7010),
    );
    expect(nonMemberOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.FORBIDDEN);

    // Absent workspace -> 403
    const absentWsOutcome = await service.close(
      subjectOwner,
      absentWorkspaceId,
      accountNonZeroBalanceId,
      id(7011),
    );
    expect(absentWsOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.FORBIDDEN);

    // Foreign account (queried under workspace 1, belongs to workspace 2) -> 404
    const foreignOutcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountForeignWorkspaceId,
      id(7012),
    );
    expect(foreignOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.NOT_FOUND);

    // Absent account -> 404
    const absentAccOutcome = await service.close(
      subjectOwner,
      workspace1Id,
      absentAccountId,
      id(7013),
    );
    expect(absentAccOutcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.NOT_FOUND);
  });

  it('h. already closed: closing an already-closed account returns closed (403)', async () => {
    const outcome = await service.close(
      subjectOwner,
      workspace1Id,
      accountAlreadyClosedId,
      id(7014),
    );
    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.CLOSED);
  });
});
