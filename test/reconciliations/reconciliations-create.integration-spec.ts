// Migrations under test: 202608310002_reconciliations.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RECONCILIATION_CREATE_OUTCOMES,
  type CreateReconciliationCommand,
  type ReconciliationCreateCreated,
  type ReconciliationCreateReplayed,
} from '../../src/reconciliations/reconciliation.port.js';
import { ReconciliationService } from '../../src/reconciliations/reconciliation.service.js';
import { PostgresReconciliationAdapter } from '../../src/reconciliations/postgres-reconciliation.adapter.js';
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

describe('ReconciliationService createReconciliation database boundary and business rules', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: ReconciliationService;

  const subjectOwner = subject(5001);
  const subjectAdmin = subject(5002);
  const subjectEditor = subject(5003);
  const subjectViewer = subject(5004);
  const subjectNonMember = subject(5005);
  const subjectWs2Owner = subject(5006);

  const workspace1Id = id(5051);
  const workspace2Id = id(5052);

  const ws1AccountActiveUsd = id(5071);
  const ws1AccountClosedUsd = id(5072);
  const ws2AccountUsd = id(5074);
  const ws1AccountZeroBalanceUsd = id(5075);
  const ws1AccountNegBalanceUsd = id(5076);
  const ws1AccountPosBalanceUsd = id(5077);
  const absentAccountId = id(5099);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new ReconciliationService(
      transaction,
      new PostgresReconciliationAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'rec-cr-owner@example.test',
        subjectAdmin,
        'rec-cr-admin@example.test',
        subjectEditor,
        'rec-cr-editor@example.test',
        subjectViewer,
        'rec-cr-viewer@example.test',
        subjectNonMember,
        'rec-cr-nonmember@example.test',
        subjectWs2Owner,
        'rec-cr-ws2owner@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'rec-cr-owner@example.test', 'Rec Create Owner'],
      [subjectAdmin, 'rec-cr-admin@example.test', 'Rec Create Admin'],
      [subjectEditor, 'rec-cr-editor@example.test', 'Rec Create Editor'],
      [subjectViewer, 'rec-cr-viewer@example.test', 'Rec Create Viewer'],
      [
        subjectNonMember,
        'rec-cr-nonmember@example.test',
        'Rec Create NonMember',
      ],
      [subjectWs2Owner, 'rec-cr-ws2owner@example.test', 'Rec Create Ws2 Owner'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Rec Create WS1', 'shared', 'USD', null, $2),
              ($3, 'Rec Create WS2', 'shared', 'USD', null, $4)`,
      [workspace1Id, subjectOwner, workspace2Id, subjectWs2Owner],
    );

    // 3. Memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'administrator', 'active'),
              ($1, $4, 'editor', 'active'),
              ($1, $5, 'viewer', 'active'),
              ($6, $7, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        workspace2Id,
        subjectWs2Owner,
      ],
    );

    // 4. Accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'Active USD Account', 'checking', 'USD', 'active', null, $3),
              ($4, $2, 'Closed USD Account', 'checking', 'USD', 'closed', now(), $3),
              ($5, $6, 'WS2 Account', 'checking', 'USD', 'active', null, $7),
              ($8, $2, 'Zero Balance USD Account', 'checking', 'USD', 'active', null, $3),
              ($9, $2, 'Neg Balance USD Account', 'checking', 'USD', 'active', null, $3),
              ($10, $2, 'Pos Balance USD Account', 'checking', 'USD', 'active', null, $3)`,
      [
        ws1AccountActiveUsd,
        workspace1Id,
        subjectOwner,
        ws1AccountClosedUsd,
        ws2AccountUsd,
        workspace2Id,
        subjectWs2Owner,
        ws1AccountZeroBalanceUsd,
        ws1AccountNegBalanceUsd,
        ws1AccountPosBalanceUsd,
      ],
    );

    // 5. Seed real ledger transactions and postings
    const seedPosting = async (
      txnId: string,
      status: 'draft' | 'pending' | 'confirmed' | 'reconciled',
      amountMinor: number,
      occurredAt: string,
      accId: string = ws1AccountActiveUsd,
    ) => {
      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'income', $4, $5, 'USD', $6, $7)`,
        [
          txnId,
          workspace1Id,
          accId,
          status,
          amountMinor,
          occurredAt,
          subjectOwner,
        ],
      );
      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values
           ($1, $2, $3, 'account', $4, 'USD', $5, $6),
           ($1, $2, null, 'external', $7, 'USD', $5, $6)`,
        [
          workspace1Id,
          txnId,
          accId,
          amountMinor,
          status,
          occurredAt,
          -amountMinor,
        ],
      );
    };

    // 5a. Confirmed transaction before statementDate (2026-08-15) -> +10000 USD
    await seedPosting(id(5101), 'confirmed', 10000, '2026-08-15T10:00:00Z');

    // 5b. Reconciled transaction on statementDate (2026-08-30 22:00:00Z) -> +5000 USD
    await seedPosting(id(5102), 'reconciled', 5000, '2026-08-30T22:00:00Z');

    // 5c. Pending transaction before statementDate -> +3000 USD (MUST NOT be counted in systemBalance)
    await seedPosting(id(5103), 'pending', 3000, '2026-08-20T10:00:00Z');

    // 5d. Confirmed transaction AFTER statementDate (2026-08-31 10:00:00Z) -> +20000 USD (MUST NOT be counted)
    await seedPosting(id(5104), 'confirmed', 20000, '2026-08-31T10:00:00Z');

    // 5e. Negative balance account (-1 USD)
    await seedPosting(
      id(5105),
      'confirmed',
      -1,
      '2026-08-15T10:00:00Z',
      ws1AccountNegBalanceUsd,
    );

    // 5f. Positive balance account (+1 USD)
    await seedPosting(
      id(5106),
      'confirmed',
      1,
      '2026-08-15T10:00:00Z',
      ws1AccountPosBalanceUsd,
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(
        `delete from public.reconciliations where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
      await admin.query(
        `delete from public.ledger_postings where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
      await admin.query(
        `delete from public.transactions where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
      await admin.query(
        `delete from public.accounts where workspace_id in ($1, $2)`,
        [workspace1Id, workspace2Id],
      );
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
          subjectWs2Owner,
        ],
      );
      await admin.end();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('computes systemBalance and difference against real ledger rows as of end of statementDate (RULING 69)', async () => {
    // statementDate: 2026-08-30.
    // Confirmed postings on or before 2026-08-30 23:59:59.999999Z:
    // - txn1: +10000 (confirmed)
    // - txn2: +5000 (reconciled)
    // - txn3: +3000 (pending -> excluded)
    // - txn4: +20000 (occurred 2026-08-31 -> excluded)
    // Expected systemBalance = 15000 USD.
    // statementBalance = 16250 USD.
    // Expected difference = 16250 - 15000 = 1250 USD.
    const key = id(5201);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '16250',
        currency: 'USD',
      },
      notes: 'Monthly reconciliation for August 30',
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.CREATED);
    const rec = (outcome as ReconciliationCreateCreated).reconciliation;

    expect(rec.accountId).toBe(ws1AccountActiveUsd);
    expect(rec.statementDate).toBe('2026-08-30');
    expect(rec.statementBalance).toEqual({
      amountMinor: '16250',
      currency: 'USD',
    });
    expect(rec.systemBalance).toEqual({
      amountMinor: '15000',
      currency: 'USD',
    });
    expect(rec.difference).toEqual({
      amountMinor: '1250',
      currency: 'USD',
    });
    expect(rec.status).toBe('open');
    expect(rec.completedAt).toBeNull();

    // Verify row persisted in database
    const dbRow = await admin.query<{
      statement_balance_minor: string;
      system_balance_minor: string;
      difference_minor: string;
      notes: string;
    }>(
      `select statement_balance_minor::text, system_balance_minor::text, difference_minor::text, notes
         from public.reconciliations where id = $1`,
      [rec.id],
    );
    expect(dbRow.rows[0]).toEqual({
      statement_balance_minor: '16250',
      system_balance_minor: '15000',
      difference_minor: '1250',
      notes: 'Monthly reconciliation for August 30',
    });

    // Clean up
    await admin.query(`delete from public.reconciliations where id = $1`, [
      rec.id,
    ]);
  });

  it('answers 422 when statementBalance currency does not match account currency (RULING 70)', async () => {
    // ws1AccountActiveUsd has currency 'USD'; command supplies 'EUR'
    const key = id(5202);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '10000',
        currency: 'EUR',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.CURRENCY_MISMATCH);

    // Verify no row was inserted
    const countRes = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where workspace_id = $1 and account_id = $2`,
      [workspace1Id, ws1AccountActiveUsd],
    );
    expect(countRes.rows[0]?.count).toBe('0');
  });

  it('answers 422 when statementDate is in the future (RULING 72)', async () => {
    const key = id(5203);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2099-12-31',
      statementBalance: {
        amountMinor: '10000',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(
      RECONCILIATION_CREATE_OUTCOMES.FUTURE_STATEMENT_DATE,
    );
  });

  it('answers 422 when account does not exist in workspace (RULING 73)', async () => {
    const key = id(5204);
    const command: CreateReconciliationCommand = {
      accountId: absentAccountId,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '10000',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND);
  });

  it('answers 422 when account belongs to another workspace (RULING 73)', async () => {
    const key = id(5205);
    const command: CreateReconciliationCommand = {
      accountId: ws2AccountUsd, // Belongs to workspace2Id
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '10000',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND);
  });

  it('answers 422 when account is closed (RULING 73)', async () => {
    const key = id(5206);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountClosedUsd, // status = 'closed'
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '10000',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_CLOSED);
  });

  it('answers 409 on second open reconciliation and verifies row count = 1 (RULING 71 & Section 6)', async () => {
    const key1 = id(5207);
    const key2 = id(5208);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '15000',
        currency: 'USD',
      },
    };

    // 1. Create first open reconciliation
    const outcome1 = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key1,
    );
    expect(outcome1.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.CREATED);
    const rec1 = (outcome1 as ReconciliationCreateCreated).reconciliation;

    // 2. Second attempt with different idempotency key for same account
    const outcome2 = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      {
        ...command,
        statementBalance: { amountMinor: '18000', currency: 'USD' },
      },
      key2,
    );

    expect(outcome2.kind).toBe(
      RECONCILIATION_CREATE_OUTCOMES.OPEN_RECONCILIATION_EXISTS,
    );

    // CRITICAL (Section 6): Assert ROW COUNT is exactly 1, proving no phantom row exists
    const countRes = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where workspace_id = $1 and account_id = $2`,
      [workspace1Id, ws1AccountActiveUsd],
    );
    expect(countRes.rows[0]?.count).toBe('1');

    // Clean up
    await admin.query(`delete from public.reconciliations where id = $1`, [
      rec1.id,
    ]);
  });

  it('idempotent replay returns 201 replayed and leaves exactly ONE row in database (RULING 75 & Section 6)', async () => {
    const key = id(5209);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '15000',
        currency: 'USD',
      },
      notes: 'Initial create',
    };

    // 1. First POST
    const outcome1 = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome1.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.CREATED);
    const rec1 = (outcome1 as ReconciliationCreateCreated).reconciliation;

    // 2. Replay with identical key and command
    const outcome2 = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome2.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.REPLAYED);
    const replayed = outcome2 as ReconciliationCreateReplayed;
    expect(replayed.status).toBe(201);
    expect(
      (replayed.body as ReconciliationCreateCreated['reconciliation']).id,
    ).toBe(rec1.id);

    // CRITICAL (Section 6): Assert ROW COUNT is exactly 1
    const countRes = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where workspace_id = $1 and account_id = $2`,
      [workspace1Id, ws1AccountActiveUsd],
    );
    expect(countRes.rows[0]?.count).toBe('1');

    // 3. Replay with same key but DIFFERENT command payload -> 409 IDEMPOTENCY_CONFLICT
    const outcomeConflict = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      {
        ...command,
        statementBalance: { amountMinor: '99999', currency: 'USD' },
      },
      key,
    );
    expect(outcomeConflict.kind).toBe(
      RECONCILIATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    );

    // Row count still exactly 1
    const countResAfter = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where workspace_id = $1 and account_id = $2`,
      [workspace1Id, ws1AccountActiveUsd],
    );
    expect(countResAfter.rows[0]?.count).toBe('1');

    // Clean up
    await admin.query(`delete from public.reconciliations where id = $1`, [
      rec1.id,
    ]);
  });

  it('refuses access with FORBIDDEN (403) for viewer or non-member caller', async () => {
    const key1 = id(5210);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '15000',
        currency: 'USD',
      },
    };

    const outcomeViewer = await service.createReconciliation(
      subjectViewer,
      workspace1Id,
      command,
      key1,
    );
    expect(outcomeViewer.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.FORBIDDEN);

    const key2 = id(5211);
    const outcomeNonMember = await service.createReconciliation(
      subjectNonMember,
      workspace1Id,
      command,
      key2,
    );
    expect(outcomeNonMember.kind).toBe(
      RECONCILIATION_CREATE_OUTCOMES.FORBIDDEN,
    );
  });

  it('serializes against closeAccount via per-account advisory lock (RULING 77)', async () => {
    // 1. Session A: raw admin client takes advisory lock on ws1AccountActiveUsd and leaves transaction open
    const sessionA = await admin.connect();
    await sessionA.query('BEGIN');
    await sessionA.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [ws1AccountActiveUsd.toLowerCase()],
    );

    const command: CreateReconciliationCommand = {
      accountId: ws1AccountActiveUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '16250',
        currency: 'USD',
      },
    };

    let sessionBCompleted = false;
    const sessionBPromise = service
      .createReconciliation(
        subjectOwner,
        workspace1Id,
        command,
        id(5290),
      )
      .then((res) => {
        sessionBCompleted = true;
        return res;
      });

    // Session B must NOT complete while Session A holds the lock
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sessionBCompleted).toBe(false);

    // Session A closes the account and commits
    await sessionA.query(
      `update public.accounts set status = 'closed', closed_at = now(), version = version + 1 where id = $1`,
      [ws1AccountActiveUsd],
    );
    await sessionA.query('COMMIT');
    sessionA.release();

    // Session B unblocks, reads under the lock that the account is closed, and answers ACCOUNT_CLOSED (422)
    const outcome = await sessionBPromise;
    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_CLOSED);

    // Assert that NO open reconciliation exists against the closed account in the database
    const recCheck = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where account_id = $1`,
      [ws1AccountActiveUsd],
    );
    expect(recCheck.rows[0]?.count).toBe('0');

    // Restore account to active for any subsequent operations
    await admin.query(
      `update public.accounts set status = 'active', closed_at = null, version = version + 1 where id = $1`,
      [ws1AccountActiveUsd],
    );
  });

  it('answers 422 AMOUNT_OUT_OF_RANGE when difference exceeds int64 max (max minus negative) (RULING 78)', async () => {
    // ws1AccountNegBalanceUsd has systemBalance = -1 USD
    // statementBalance = 9223372036854775807 (int64 max)
    // difference = 9223372036854775807 - (-1) = 9223372036854775808 (overflows int64)
    const key = id(5291);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountNegBalanceUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '9223372036854775807',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(
      RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE,
    );

    const recCheck = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where account_id = $1`,
      [ws1AccountNegBalanceUsd],
    );
    expect(recCheck.rows[0]?.count).toBe('0');
  });

  it('answers 422 AMOUNT_OUT_OF_RANGE when difference underflows int64 min (min minus positive) (RULING 78)', async () => {
    // ws1AccountPosBalanceUsd has systemBalance = +1 USD
    // statementBalance = -9223372036854775808 (int64 min)
    // difference = -9223372036854775808 - 1 = -9223372036854775809 (underflows int64)
    const key = id(5292);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountPosBalanceUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '-9223372036854775808',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(
      RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE,
    );

    const recCheck = await admin.query<{ count: string }>(
      `select count(*)::text from public.reconciliations where account_id = $1`,
      [ws1AccountPosBalanceUsd],
    );
    expect(recCheck.rows[0]?.count).toBe('0');
  });

  it('succeeds at exactly int64 max statementBalance with systemBalance of 0 (positive boundary) (RULING 78)', async () => {
    // ws1AccountZeroBalanceUsd has systemBalance = 0 USD
    // statementBalance = 9223372036854775807 (int64 max)
    // difference = 9223372036854775807 - 0 = 9223372036854775807 (fits int64)
    const key = id(5293);
    const command: CreateReconciliationCommand = {
      accountId: ws1AccountZeroBalanceUsd,
      statementDate: '2026-08-30',
      statementBalance: {
        amountMinor: '9223372036854775807',
        currency: 'USD',
      },
    };

    const outcome = await service.createReconciliation(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );

    expect(outcome.kind).toBe(RECONCILIATION_CREATE_OUTCOMES.CREATED);
    const rec = (outcome as ReconciliationCreateCreated).reconciliation;
    expect(rec.statementBalance.amountMinor).toBe('9223372036854775807');
    expect(rec.systemBalance.amountMinor).toBe('0');
    expect(rec.difference.amountMinor).toBe('9223372036854775807');

    const dbRow = await admin.query<{
      statement_balance_minor: string;
      system_balance_minor: string;
      difference_minor: string;
    }>(
      `select statement_balance_minor::text, system_balance_minor::text, difference_minor::text
         from public.reconciliations where id = $1`,
      [rec.id],
    );
    expect(dbRow.rows[0]).toEqual({
      statement_balance_minor: '9223372036854775807',
      system_balance_minor: '0',
      difference_minor: '9223372036854775807',
    });

    // Clean up
    await admin.query(`delete from public.reconciliations where id = $1`, [
      rec.id,
    ]);
  });
});
