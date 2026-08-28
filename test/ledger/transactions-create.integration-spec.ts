import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRANSACTION_CREATE_OUTCOMES,
  type CreateTransactionCommand,
  type TransactionCreateCreated,
  type TransactionCreateReplayed,
} from '../../src/ledger/ledger.port.js';
import {
  TransactionService,
  type LedgerStore,
} from '../../src/ledger/transaction.service.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import {
  PgTransaction,
  type TransactionClient,
} from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('TransactionService createTransaction database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: TransactionService;

  const subjectOwner = subject(841);
  const subjectAdmin = subject(842);
  const subjectEditor = subject(843);
  const subjectViewer = subject(844);
  const subjectNonMember = subject(845);

  const workspace1Id = id(881);
  const workspace2Id = id(882);

  const accountActiveId = id(6001);
  const accountClosedId = id(6002);
  const accountForeignWsId = id(6003);
  const absentAccountId = id(6999);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
      [
        subjectOwner,
        'txn-owner@example.test',
        subjectAdmin,
        'txn-admin@example.test',
        subjectEditor,
        'txn-editor@example.test',
        subjectViewer,
        'txn-viewer@example.test',
        subjectNonMember,
        'txn-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'txn-owner@example.test', 'Txn Owner'],
      [subjectAdmin, 'txn-admin@example.test', 'Txn Admin'],
      [subjectEditor, 'txn-editor@example.test', 'Txn Editor'],
      [subjectViewer, 'txn-viewer@example.test', 'Txn Viewer'],
      [subjectNonMember, 'txn-nonmember@example.test', 'Txn Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Txn Workspace One'],
      [workspace2Id, 'Txn Workspace Two'],
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
      // accounts_check enforces (status = 'closed') = (closed_at is not null),
      // so a seeded closed account must carry its closure timestamp.
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'Active Checking', 'checking', 'USD', 'active', null, $3),
              ($4, $2, 'Closed Savings', 'savings', 'USD', 'closed', now(), $3),
              ($5, $6, 'Foreign Account', 'checking', 'USD', 'active', null, $3)`,
      [
        accountActiveId,
        workspace1Id,
        subjectOwner,
        accountClosedId,
        accountForeignWsId,
        workspace2Id,
      ],
    );
  });

  afterAll(async () => {
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      workspace1Id,
      workspace2Id,
    ]);
    await admin.query(
      `delete from auth.users where id in ($1, $2, $3, $4, $5)`,
      [
        subjectOwner,
        subjectAdmin,
        subjectEditor,
        subjectViewer,
        subjectNonMember,
      ],
    );
    await pool.end();
    await admin.end();
  });

  it('201 happy path: writes transactions row AND balanced ledger_postings pair summing to zero', async () => {
    const key = '00000000-0000-4000-8000-000000000001';
    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: accountActiveId,
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
      description: 'Office Supplies',
      notes: 'Pens and paper',
    };

    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_CREATE_OUTCOMES.CREATED);
    const created = (outcome as TransactionCreateCreated).transaction;
    expect(created.id).toBeDefined();
    expect(created.amount.amountMinor).toBe('5000');
    expect(created.amount.currency).toBe('USD');
    expect(created.status).toBe('confirmed');

    // Verify transactions row in DB
    const txnRows = await admin.query(
      `select * from public.transactions where id = $1::uuid`,
      [created.id],
    );
    expect(txnRows.rows.length).toBe(1);
    expect(txnRows.rows[0].workspace_id).toBe(workspace1Id);
    expect(txnRows.rows[0].account_id).toBe(accountActiveId);
    expect(txnRows.rows[0].amount_minor).toBe('5000');
    expect(txnRows.rows[0].currency).toBe('USD');

    // Verify ledger_postings rows in DB
    const postingRows = await admin.query<{
      account_id: string | null;
      leg_kind: string;
      amount_minor: string;
      currency: string;
    }>(
      `select account_id, leg_kind, amount_minor, currency from public.ledger_postings where transaction_id = $1::uuid order by leg_kind`,
      [created.id],
    );
    expect(postingRows.rows.length).toBe(2);

    const accountLeg = postingRows.rows.find((r) => r.leg_kind === 'account');
    const externalLeg = postingRows.rows.find((r) => r.leg_kind === 'external');

    expect(accountLeg).toBeDefined();
    expect(accountLeg?.account_id).toBe(accountActiveId);
    expect(accountLeg?.amount_minor).toBe('5000');
    expect(accountLeg?.currency).toBe('USD');

    expect(externalLeg).toBeDefined();
    expect(externalLeg?.account_id).toBeNull();
    expect(externalLeg?.amount_minor).toBe('-5000');
    expect(externalLeg?.currency).toBe('USD');

    // Balanced sum
    const sumResult = await admin.query<{ sum: string }>(
      `select sum(amount_minor)::text as sum from public.ledger_postings where transaction_id = $1::uuid`,
      [created.id],
    );
    expect(sumResult.rows[0].sum).toBe('0');
  });

  it('atomicity: rollback on failure leaves neither transaction nor postings', async () => {
    let generatedTxnId: string | undefined;
    const realAdapter = new PostgresTransactionAdapter();

    const wrappingAdapter: LedgerStore = {
      readActiveRole: (client: TransactionClient, ws: string) =>
        realAdapter.readActiveRole(client, ws),
      lockAndReadAccount: (
        client: TransactionClient,
        ws: string,
        acc: string,
      ) => realAdapter.lockAndReadAccount(client, ws, acc),
      readTransaction: (client: TransactionClient, ws: string, txnId: string) =>
        realAdapter.readTransaction(client, ws, txnId),
      listTransactions: (
        client: TransactionClient,
        ws: string,
        cursor: Parameters<PostgresTransactionAdapter['listTransactions']>[2],
        limit: number,
        filters: Parameters<PostgresTransactionAdapter['listTransactions']>[4],
      ) => realAdapter.listTransactions(client, ws, cursor, limit, filters),
      updateTransaction: (
        client: TransactionClient,
        ws: string,
        id: string,
        cmd: Parameters<PostgresTransactionAdapter['updateTransaction']>[3],
        exp?: Parameters<PostgresTransactionAdapter['updateTransaction']>[4],
      ) => realAdapter.updateTransaction(client, ws, id, cmd, exp),
      voidTransaction: (
        client: TransactionClient,
        ws: string,
        id: string,
        acc: string,
        st: string,
        exp?: Parameters<PostgresTransactionAdapter['voidTransaction']>[5],
      ) => realAdapter.voidTransaction(client, ws, id, acc, st, exp),
      createTransaction: async (
        client: TransactionClient,
        ws: string,
        sub: string,
        cmd: CreateTransactionCommand,
      ) => {
        const interceptedClient: TransactionClient = {
          query: async <Row extends Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ) => {
            const res = await client.query<Row>(text, values);
            const firstRow = res.rows[0] as Record<string, unknown> | undefined;
            if (
              typeof text === 'string' &&
              text.includes('insert into public.transactions') &&
              typeof firstRow?.id === 'string'
            ) {
              generatedTxnId = firstRow.id;
            }
            if (
              typeof text === 'string' &&
              text.includes('insert into public.ledger_postings')
            ) {
              throw new Error('Injected postings insert failure');
            }
            return res;
          },
        };
        return realAdapter.createTransaction(interceptedClient, ws, sub, cmd);
      },
    };

    const faultyService = new TransactionService(
      transaction,
      wrappingAdapter,
      new PostgresIdempotencyAdapter(),
    );

    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: accountActiveId,
      amount: { amountMinor: '3333', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
      description: 'Atomic Failure Test',
    };

    await expect(
      faultyService.create(
        subjectOwner,
        workspace1Id,
        command,
        '00000000-0000-4000-8000-000000000099',
      ),
    ).rejects.toThrow('Injected postings insert failure');

    expect(generatedTxnId).toBeDefined();

    // Assert by the generated transaction identity that NEITHER public.transactions NOR public.ledger_postings retained any row
    const txnCheck = await admin.query(
      'select * from public.transactions where id = $1::uuid',
      [generatedTxnId],
    );
    expect(txnCheck.rows).toHaveLength(0);

    const postingsCheck = await admin.query(
      'select * from public.ledger_postings where transaction_id = $1::uuid',
      [generatedTxnId],
    );
    expect(postingsCheck.rows).toHaveLength(0);
  });

  it('serializes against closeAccount via per-account advisory lock', async () => {
    // 1. Session A: a raw admin client takes advisory lock on accountActiveId and leaves transaction open
    const sessionA = await admin.connect();
    await sessionA.query('BEGIN');
    await sessionA.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountActiveId.toLowerCase()],
    );

    // 2. Session B: call service.create for that same account
    const command: CreateTransactionCommand = {
      type: 'income',
      accountId: accountActiveId,
      amount: { amountMinor: '2000', currency: 'USD' },
      occurredAt: '2026-08-20T12:00:00.000Z',
      status: 'confirmed',
    };

    let sessionBCompleted = false;
    const sessionBPromise = service
      .create(
        subjectOwner,
        workspace1Id,
        command,
        '00000000-0000-4000-8000-000000000003',
      )
      .then((res) => {
        sessionBCompleted = true;
        return res;
      });

    // Verify Session B MUST NOT complete while Session A holds the lock
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sessionBCompleted).toBe(false);

    // 3. Release Session A
    await sessionA.query('ROLLBACK');
    sessionA.release();

    // 4. Assert Session B then completes successfully
    const outcome = await sessionBPromise;
    expect(outcome.kind).toBe(TRANSACTION_CREATE_OUTCOMES.CREATED);

    // 5. Negative control: Repeat with Session A holding lock for a DIFFERENT account id
    const differentAccountId = id(7777);
    const sessionA2 = await admin.connect();
    await sessionA2.query('BEGIN');
    await sessionA2.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [differentAccountId.toLowerCase()],
    );

    // Session B for accountActiveId completes immediately while sessionA2 holds lock for differentAccountId
    const outcomeControl = await service.create(
      subjectOwner,
      workspace1Id,
      {
        ...command,
        amount: { amountMinor: '2500', currency: 'USD' },
      },
      '00000000-0000-4000-8000-000000000033',
    );
    expect(outcomeControl.kind).toBe(TRANSACTION_CREATE_OUTCOMES.CREATED);

    await sessionA2.query('ROLLBACK');
    sessionA2.release();
  });

  it('refuses unresolved account in workspace with ACCOUNT_UNRESOLVED', async () => {
    const key = '00000000-0000-4000-8000-000000000004';
    const commandAbsent: CreateTransactionCommand = {
      type: 'expense',
      accountId: absentAccountId,
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
    };
    const outcomeAbsent = await service.create(
      subjectOwner,
      workspace1Id,
      commandAbsent,
      key,
    );
    expect(outcomeAbsent.kind).toBe(
      TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    );

    // Foreign workspace account also resolves to ACCOUNT_UNRESOLVED
    const commandForeign: CreateTransactionCommand = {
      type: 'expense',
      accountId: accountForeignWsId,
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
    };
    const outcomeForeign = await service.create(
      subjectOwner,
      workspace1Id,
      commandForeign,
      '00000000-0000-4000-8000-000000000005',
    );
    expect(outcomeForeign.kind).toBe(
      TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    );
  });

  it('refuses closed account with ACCOUNT_CLOSED', async () => {
    const key = '00000000-0000-4000-8000-000000000006';
    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: accountClosedId,
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
    };
    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED);
  });

  it('idempotent replay returns stored response and does not duplicate transaction rows', async () => {
    const key = '00000000-0000-4000-8000-000000000007';
    const command: CreateTransactionCommand = {
      type: 'income',
      accountId: accountActiveId,
      amount: { amountMinor: '7500', currency: 'USD' },
      occurredAt: '2026-08-20T14:00:00.000Z',
      status: 'confirmed',
      description: 'Consulting Fee',
    };

    const first = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(first.kind).toBe(TRANSACTION_CREATE_OUTCOMES.CREATED);
    const firstTxn = (first as TransactionCreateCreated).transaction;

    const second = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(second.kind).toBe(TRANSACTION_CREATE_OUTCOMES.REPLAYED);
    const replayed = second as TransactionCreateReplayed;
    expect(replayed.status).toBe(201);
    expect((replayed.body as { id: string }).id).toBe(firstTxn.id);

    // Verify only 1 transaction row with this description exists
    const rows = await admin.query(
      `select count(*) from public.transactions where workspace_id = $1 and description = 'Consulting Fee'`,
      [workspace1Id],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('refuses 403 for a viewer and blocks persistence (0 rows written)', async () => {
    const key = '00000000-0000-4000-8000-000000000008';
    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: accountActiveId,
      amount: { amountMinor: '9999', currency: 'USD' },
      occurredAt: '2026-08-20T15:00:00.000Z',
      status: 'confirmed',
      description: 'Viewer Attempt',
    };

    const outcome = await service.create(
      subjectViewer,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSACTION_CREATE_OUTCOMES.FORBIDDEN);

    const rows = await admin.query(
      `select count(*) from public.transactions where description = 'Viewer Attempt'`,
    );
    expect(Number(rows.rows[0].count)).toBe(0);
  });
});
