import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRANSFER_CREATE_OUTCOMES,
  type CreateTransferCommand,
  type TransferCreateCreated,
  type TransferCreateReplayed,
} from '../../src/ledger/transfer.port.js';
import {
  TransferService,
  type TransferStore,
} from '../../src/ledger/transfer.service.js';
import { PostgresTransferAdapter } from '../../src/ledger/postgres-transfer.adapter.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
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

describe('TransferService createTransfer database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: TransferService;
  let transactionService: TransactionService;

  const subjectOwner = subject(851);
  const subjectAdmin = subject(852);
  const subjectEditor = subject(853);
  const subjectViewer = subject(854);
  const subjectNonMember = subject(855);

  const workspace1Id = id(891);
  const workspace2Id = id(892);

  const accountActiveUSD1Id = id(7001);
  const accountActiveUSD2Id = id(7002);
  const accountClosedUSDId = id(7004);
  const accountForeignWsId = id(7005);
  const absentAccountId = id(7999);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new TransferService(
      transaction,
      new PostgresTransferAdapter(),
      new PostgresIdempotencyAdapter(),
    );
    transactionService = new TransactionService(
      transaction,
      new PostgresTransactionAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
      [
        subjectOwner,
        'transfer-owner@example.test',
        subjectAdmin,
        'transfer-admin@example.test',
        subjectEditor,
        'transfer-editor@example.test',
        subjectViewer,
        'transfer-viewer@example.test',
        subjectNonMember,
        'transfer-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'transfer-owner@example.test', 'Transfer Owner'],
      [subjectAdmin, 'transfer-admin@example.test', 'Transfer Admin'],
      [subjectEditor, 'transfer-editor@example.test', 'Transfer Editor'],
      [subjectViewer, 'transfer-viewer@example.test', 'Transfer Viewer'],
      [
        subjectNonMember,
        'transfer-nonmember@example.test',
        'Transfer Non Member',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Transfer Workspace One'],
      [workspace2Id, 'Transfer Workspace Two'],
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
    // accounts_check enforces (status = 'closed') = (closed_at is not null)
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'USD Checking 1', 'checking', 'USD', 'active', null, $3),
              ($4, $2, 'USD Savings 2', 'savings', 'USD', 'active', null, $3),
              ($5, $2, 'Closed USD Account', 'savings', 'USD', 'closed', now(), $3),
              ($6, $7, 'Foreign WS2 Account', 'checking', 'USD', 'active', null, $3)`,
      [
        accountActiveUSD1Id,
        workspace1Id,
        subjectOwner,
        accountActiveUSD2Id,
        accountClosedUSDId,
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

  it('201 happy path: writes transfers row AND balanced ledger_postings pair summing to zero across the two accounts', async () => {
    const key = '00000000-0000-4000-8000-000000001001';
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-08-25T10:00:00.000Z',
      description: 'Transfer savings',
    };

    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CREATED);
    const created = (outcome as TransferCreateCreated).transfer;
    expect(created.id).toBeDefined();
    expect(created.sourceAccountId).toBe(accountActiveUSD1Id);
    expect(created.destinationAccountId).toBe(accountActiveUSD2Id);
    expect(created.sourceAmount).toEqual({
      amountMinor: '5000',
      currency: 'USD',
    });
    expect(created.destinationAmount).toEqual({
      amountMinor: '5000',
      currency: 'USD',
    });
    expect(created.status).toBe('confirmed');
    expect(created.fee).toBeUndefined();
    expect(created.transactionId).toBeUndefined();

    // Verify public.transfers row in DB
    const transferRows = await admin.query(
      `select * from public.transfers where id = $1::uuid`,
      [created.id],
    );
    expect(transferRows.rows.length).toBe(1);
    expect(transferRows.rows[0].workspace_id).toBe(workspace1Id);
    expect(transferRows.rows[0].source_account_id).toBe(accountActiveUSD1Id);
    expect(transferRows.rows[0].destination_account_id).toBe(
      accountActiveUSD2Id,
    );
    expect(transferRows.rows[0].source_amount_minor).toBe('5000');
    expect(transferRows.rows[0].source_currency).toBe('USD');
    expect(transferRows.rows[0].destination_amount_minor).toBe('5000');
    expect(transferRows.rows[0].destination_currency).toBe('USD');
    expect(transferRows.rows[0].fee_amount_minor).toBeNull();
    expect(transferRows.rows[0].fee_currency).toBeNull();
    expect(transferRows.rows[0].transaction_id).toBeNull();

    // Verify ledger_postings rows in DB: both legs have transfer_id set and transaction_id null
    const postingRows = await admin.query<{
      transfer_id: string;
      transaction_id: string | null;
      account_id: string;
      leg_kind: string;
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      `select transfer_id, transaction_id, account_id, leg_kind, amount_minor, currency, status from public.ledger_postings where transfer_id = $1::uuid order by amount_minor asc`,
      [created.id],
    );
    expect(postingRows.rows.length).toBe(2);

    const debitLeg = postingRows.rows.find(
      (r) => r.account_id === accountActiveUSD1Id,
    );
    const creditLeg = postingRows.rows.find(
      (r) => r.account_id === accountActiveUSD2Id,
    );

    expect(debitLeg).toBeDefined();
    expect(debitLeg?.transfer_id).toBe(created.id);
    expect(debitLeg?.transaction_id).toBeNull();
    expect(debitLeg?.leg_kind).toBe('account');
    expect(debitLeg?.amount_minor).toBe('-5000');
    expect(debitLeg?.currency).toBe('USD');
    expect(debitLeg?.status).toBe('confirmed');

    expect(creditLeg).toBeDefined();
    expect(creditLeg?.transfer_id).toBe(created.id);
    expect(creditLeg?.transaction_id).toBeNull();
    expect(creditLeg?.leg_kind).toBe('account');
    expect(creditLeg?.amount_minor).toBe('5000');
    expect(creditLeg?.currency).toBe('USD');
    expect(creditLeg?.status).toBe('confirmed');

    // Balance arithmetic: pair's sum is 0
    const sumResult = await admin.query<{ sum: string }>(
      `select sum(amount_minor)::text as sum from public.ledger_postings where transfer_id = $1::uuid`,
      [created.id],
    );
    expect(sumResult.rows[0].sum).toBe('0');
  });

  it('201 with optional fee: writes fee in transfer row and emits fee in Transfer body', async () => {
    const key = '00000000-0000-4000-8000-000000001002';
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '3000', currency: 'USD' },
      occurredAt: '2026-08-25T11:00:00.000Z',
      fee: { amountMinor: '50', currency: 'USD' },
      description: 'Transfer with fee',
    };

    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CREATED);
    const created = (outcome as TransferCreateCreated).transfer;
    expect(created.fee).toEqual({
      amountMinor: '50',
      currency: 'USD',
    });

    const transferRows = await admin.query(
      `select fee_amount_minor, fee_currency, transaction_id from public.transfers where id = $1::uuid`,
      [created.id],
    );
    expect(transferRows.rows[0].fee_amount_minor).toBe('50');
    expect(transferRows.rows[0].fee_currency).toBe('USD');
  });

  it('atomicity by fault injection: failure between transfer insert and postings insert leaves neither transfer nor postings in production path', async () => {
    let generatedTransferId: string | undefined;
    const realAdapter = new PostgresTransferAdapter();

    const wrappingAdapter: TransferStore = {
      readActiveRole: (client: TransactionClient, ws: string) =>
        realAdapter.readActiveRole(client, ws),
      lockAndReadAccounts: (
        client: TransactionClient,
        ws: string,
        src: string,
        dst: string,
      ) => realAdapter.lockAndReadAccounts(client, ws, src, dst),
      createTransfer: async (
        client: TransactionClient,
        ws: string,
        sub: string,
        cmd: CreateTransferCommand,
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
              text.includes('insert into public.transfers') &&
              typeof firstRow?.id === 'string'
            ) {
              generatedTransferId = firstRow.id;
            }
            if (
              typeof text === 'string' &&
              text.includes('insert into public.ledger_postings')
            ) {
              throw new Error(
                'Injected postings insert failure for transfer atomicity',
              );
            }
            return res;
          },
        };
        return realAdapter.createTransfer(interceptedClient, ws, sub, cmd);
      },
    };

    const faultyService = new TransferService(
      transaction,
      wrappingAdapter,
      new PostgresIdempotencyAdapter(),
    );

    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '7777', currency: 'USD' },
      occurredAt: '2026-08-25T12:00:00.000Z',
      description: 'Atomic Fault Injection Test',
    };

    await expect(
      faultyService.create(
        subjectOwner,
        workspace1Id,
        command,
        '00000000-0000-4000-8000-000000001099',
      ),
    ).rejects.toThrow(
      'Injected postings insert failure for transfer atomicity',
    );

    expect(generatedTransferId).toBeDefined();

    // Assert by the generated transfer identity that NEITHER public.transfers NOR public.ledger_postings retained any row
    const transferCheck = await admin.query(
      'select * from public.transfers where id = $1::uuid',
      [generatedTransferId],
    );
    expect(transferCheck.rows).toHaveLength(0);

    const postingsCheck = await admin.query(
      'select * from public.ledger_postings where transfer_id = $1::uuid',
      [generatedTransferId],
    );
    expect(postingsCheck.rows).toHaveLength(0);
  });

  it('serializes concurrent transfers and transactions using sorted per-account advisory locks', async () => {
    // 1. Session A: a raw admin client takes advisory lock on accountActiveUSD1Id and leaves transaction open
    const sessionA = await admin.connect();
    await sessionA.query('BEGIN');
    await sessionA.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountActiveUSD1Id.toLowerCase()],
    );

    // 2. Session B: call service.create involving accountActiveUSD1Id (transfers from USD2 to USD1)
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD2Id,
      destinationAccountId: accountActiveUSD1Id,
      amount: { amountMinor: '1200', currency: 'USD' },
      occurredAt: '2026-08-25T13:00:00.000Z',
    };

    let sessionBCompleted = false;
    const sessionBPromise = service
      .create(
        subjectOwner,
        workspace1Id,
        command,
        '00000000-0000-4000-8000-000000001003',
      )
      .then((res) => {
        sessionBCompleted = true;
        return res;
      });

    // Verify Session B MUST NOT complete while Session A holds the lock on USD1
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sessionBCompleted).toBe(false);

    // 3. Release Session A
    await sessionA.query('ROLLBACK');
    sessionA.release();

    // 4. Assert Session B then completes successfully
    const outcome = await sessionBPromise;
    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CREATED);
  });

  // The cross-account variant of this guard (sourceAccount.currency !==
  // destinationAccount.currency) is unreachable against a real database:
  // 202608240006_account_currency_invariant.sql forces every account's currency to
  // equal its workspace's base_currency, and base_currency is char(3) NOT NULL, so
  // two accounts in one workspace can never hold different currencies. Seeding that
  // state is what broke this suite. That branch stays in production code as defense
  // in depth, and its coverage lives in test/ledger/transfer.service.spec.ts, where a
  // test double can fabricate the state the database forbids.
  it('refuses a transfer whose request amount currency differs from the account currency with CURRENCY_MISMATCH', async () => {
    const key = '00000000-0000-4000-8000-000000001004';
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '1000', currency: 'EUR' },
      occurredAt: '2026-08-25T14:00:00.000Z',
    };

    const before = await admin.query(
      `select count(*)::text as count from public.transfers where workspace_id = $1::uuid`,
      [workspace1Id],
    );

    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH);

    // A refused transfer must leave no trace. Earlier tests in this file already
    // wrote transfers to this workspace, so pin that the count is UNCHANGED rather
    // than zero -- otherwise this assertion would fail for the wrong reason.
    const after = await admin.query(
      `select count(*)::text as count from public.transfers where workspace_id = $1::uuid`,
      [workspace1Id],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('refuses unresolved source or destination account in workspace with ACCOUNT_UNRESOLVED', async () => {
    const key = '00000000-0000-4000-8000-000000001005';
    const commandAbsent: CreateTransferCommand = {
      sourceAccountId: absentAccountId,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-08-25T14:00:00.000Z',
    };
    const outcomeAbsent = await service.create(
      subjectOwner,
      workspace1Id,
      commandAbsent,
      key,
    );
    expect(outcomeAbsent.kind).toBe(
      TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    );

    // Foreign workspace account also resolves to ACCOUNT_UNRESOLVED
    const commandForeign: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountForeignWsId,
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-08-25T14:00:00.000Z',
    };
    const outcomeForeign = await service.create(
      subjectOwner,
      workspace1Id,
      commandForeign,
      '00000000-0000-4000-8000-000000001006',
    );
    expect(outcomeForeign.kind).toBe(
      TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    );
  });

  it('refuses closed account with ACCOUNT_CLOSED', async () => {
    const key = '00000000-0000-4000-8000-000000001007';
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountClosedUSDId,
      amount: { amountMinor: '1000', currency: 'USD' },
      occurredAt: '2026-08-25T14:00:00.000Z',
    };
    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED);
  });

  it('idempotent replay returns stored response and does not duplicate transfer or posting rows', async () => {
    const key = '00000000-0000-4000-8000-000000001008';
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '6500', currency: 'USD' },
      occurredAt: '2026-08-25T15:00:00.000Z',
      description: 'Idempotent Transfer',
    };

    const first = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(first.kind).toBe(TRANSFER_CREATE_OUTCOMES.CREATED);
    const firstTransfer = (first as TransferCreateCreated).transfer;

    const second = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(second.kind).toBe(TRANSFER_CREATE_OUTCOMES.REPLAYED);
    const replayed = second as TransferCreateReplayed;
    expect(replayed.status).toBe(201);
    expect((replayed.body as { id: string }).id).toBe(firstTransfer.id);

    // Verify only 1 transfer row with this id exists
    const rows = await admin.query(
      `select count(*) from public.transfers where workspace_id = $1 and id = $2::uuid`,
      [workspace1Id, firstTransfer.id],
    );
    expect(Number(rows.rows[0].count)).toBe(1);

    // Verify exactly 2 posting rows for this transfer exist
    const postingCount = await admin.query(
      `select count(*) from public.ledger_postings where transfer_id = $1::uuid`,
      [firstTransfer.id],
    );
    expect(Number(postingCount.rows[0].count)).toBe(2);
  });

  it('refuses 403 for a viewer and blocks persistence (0 transfer rows written)', async () => {
    const key = '00000000-0000-4000-8000-000000001009';
    const command: CreateTransferCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      amount: { amountMinor: '9999', currency: 'USD' },
      occurredAt: '2026-08-25T16:00:00.000Z',
      description: 'Viewer Transfer Attempt',
    };

    const outcome = await service.create(
      subjectViewer,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.FORBIDDEN);

    const rows = await admin.query(
      `select count(*) from public.transfers where workspace_id = $1 and source_amount_minor = 9999`,
      [workspace1Id],
    );
    expect(Number(rows.rows[0].count)).toBe(0);
  });

  it('carry-forward from listTransactions: unfiltered GET /v1/transactions never shows transfer legs because transfers never write to public.transactions', async () => {
    // 1. Create a dedicated workspace for this test to isolate transaction listings
    const wsIsoId = id(899);
    const acc1IsoId = id(7091);
    const acc2IsoId = id(7092);

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Isolation Workspace', 'shared', 'USD', null)`,
      [wsIsoId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsIsoId, subjectOwner],
    );
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'Iso Acc 1', 'checking', 'USD', 'active', null, $3),
              ($4, $2, 'Iso Acc 2', 'savings', 'USD', 'active', null, $3)`,
      [acc1IsoId, wsIsoId, subjectOwner, acc2IsoId],
    );

    try {
      // 2. Create a real transfer in this isolated workspace
      const transferKey = '00000000-0000-4000-8000-000000001010';
      const transferOutcome = await service.create(
        subjectOwner,
        wsIsoId,
        {
          sourceAccountId: acc1IsoId,
          destinationAccountId: acc2IsoId,
          amount: { amountMinor: '8888', currency: 'USD' },
          occurredAt: '2026-08-25T17:00:00.000Z',
          description: 'Isolated Transfer',
        },
        transferKey,
      );
      expect(transferOutcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CREATED);
      const createdTransfer = (transferOutcome as TransferCreateCreated)
        .transfer;

      // 3. Issue an UNFILTERED list transactions query in this workspace
      const listOutcome = await transactionService.list(subjectOwner, {
        workspaceId: wsIsoId,
        limit: 50,
      });

      // 4. Assert that list transactions returns OK with 0 items (transfers do not write to public.transactions)
      expect(listOutcome.kind).toBe('ok');
      if (listOutcome.kind === 'ok') {
        expect(listOutcome.page.items).toHaveLength(0);
        // Verify none of the items matches the transfer ID or amount
        const found = listOutcome.page.items.find(
          (t) => t.id === createdTransfer.id || t.amount.amountMinor === '8888',
        );
        expect(found).toBeUndefined();
      }

      // Also verify direct DB count on public.transactions in this workspace
      const txnCount = await admin.query(
        `select count(*) from public.transactions where workspace_id = $1::uuid`,
        [wsIsoId],
      );
      expect(Number(txnCount.rows[0].count)).toBe(0);
    } finally {
      await admin.query(`delete from public.workspaces where id = $1::uuid`, [
        wsIsoId,
      ]);
    }
  });
});
