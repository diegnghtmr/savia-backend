import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CURRENCY_EXCHANGE_CREATE_OUTCOMES,
  type CreateCurrencyExchangeCommand,
  type CurrencyExchangeCreateCreated,
  type CurrencyExchangeCreateReplayed,
} from '../../src/ledger/currency-exchange.port.js';
import { CurrencyExchangeService } from '../../src/ledger/currency-exchange.service.js';
import { PostgresCurrencyExchangeAdapter } from '../../src/ledger/postgres-currency-exchange.adapter.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
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

describe('CurrencyExchangeService createCurrencyExchange database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: CurrencyExchangeService;
  let transactionService: TransactionService;

  const subjectOwner = subject(871);
  const subjectAdmin = subject(872);
  const subjectEditor = subject(873);
  const subjectViewer = subject(874);
  const subjectNonMember = subject(875);

  const workspace1Id = id(871);
  const workspace2Id = id(872);

  const accountActiveUSD1Id = id(7101);
  const accountActiveUSD2Id = id(7102);
  const accountActiveEURId = id(7103);
  const accountClosedEURId = id(7104);
  const accountForeignWsId = id(7105);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new CurrencyExchangeService(
      transaction,
      new PostgresCurrencyExchangeAdapter(),
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
        'exchange-owner@example.test',
        subjectAdmin,
        'exchange-admin@example.test',
        subjectEditor,
        'exchange-editor@example.test',
        subjectViewer,
        'exchange-viewer@example.test',
        subjectNonMember,
        'exchange-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'exchange-owner@example.test', 'Exchange Owner'],
      [subjectAdmin, 'exchange-admin@example.test', 'Exchange Admin'],
      [subjectEditor, 'exchange-editor@example.test', 'Exchange Editor'],
      [subjectViewer, 'exchange-viewer@example.test', 'Exchange Viewer'],
      [
        subjectNonMember,
        'exchange-nonmember@example.test',
        'Exchange Non Member',
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
      [workspace1Id, 'Exchange Workspace One'],
      [workspace2Id, 'Exchange Workspace Two'],
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

    // 3.5 Exchange Rates (Seed order MATTERS: foreign currency account requires exchange rate row FIRST)
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values ($1, 'EUR', 'USD', 1.0800, '2026-08-01T00:00:00.000Z', 'manual', $2)`,
      [workspace1Id, subjectOwner],
    );

    // 4. Accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'USD Checking 1', 'checking', 'USD', 'active', null, $3),
              ($4, $2, 'USD Savings 2', 'savings', 'USD', 'active', null, $3),
              ($5, $2, 'EUR Checking Account', 'checking', 'EUR', 'active', null, $3),
              ($6, $2, 'Closed EUR Account', 'savings', 'EUR', 'closed', now(), $3),
              ($7, $8, 'Foreign WS2 Account', 'checking', 'USD', 'active', null, $3)`,
      [
        accountActiveUSD1Id,
        workspace1Id,
        subjectOwner,
        accountActiveUSD2Id,
        accountActiveEURId,
        accountClosedEURId,
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

  it('201 four-posting shape: writes four ledger_postings rows where source and destination currencies each balance to zero', async () => {
    const key = '00000000-0000-4000-8000-000000003001';
    const command: CreateCurrencyExchangeCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveEURId,
      sourceAmount: { amountMinor: '5000', currency: 'USD' },
      destinationAmount: { amountMinor: '4600', currency: 'EUR' },
      executedRate: '0.9200',
      referenceRate: '0.9150',
      occurredAt: '2026-08-25T10:00:00.000Z',
      description: 'Exchange USD to EUR',
    };

    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED);
    const created = (outcome as CurrencyExchangeCreateCreated).transfer;

    // Verify 4 postings exist in DB
    const postingRows = await admin.query<{
      transfer_id: string;
      transaction_id: string | null;
      account_id: string | null;
      leg_kind: string;
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      `select transfer_id, transaction_id, account_id, leg_kind, amount_minor, currency, status
       from public.ledger_postings
       where transfer_id = $1::uuid
       order by currency desc, amount_minor asc`,
      [created.id],
    );

    expect(postingRows.rows.length).toBe(4);

    // Source currency (USD): -5000 (account on USD1) and +5000 (external, account null)
    const usdAccountLeg = postingRows.rows.find(
      (r) => r.currency === 'USD' && r.leg_kind === 'account',
    );
    const usdExternalLeg = postingRows.rows.find(
      (r) => r.currency === 'USD' && r.leg_kind === 'external',
    );

    expect(usdAccountLeg).toBeDefined();
    expect(usdAccountLeg?.account_id).toBe(accountActiveUSD1Id);
    expect(usdAccountLeg?.amount_minor).toBe('-5000');
    expect(usdAccountLeg?.transaction_id).toBeNull();
    expect(usdAccountLeg?.status).toBe('confirmed');

    expect(usdExternalLeg).toBeDefined();
    expect(usdExternalLeg?.account_id).toBeNull();
    expect(usdExternalLeg?.amount_minor).toBe('5000');
    expect(usdExternalLeg?.transaction_id).toBeNull();
    expect(usdExternalLeg?.status).toBe('confirmed');

    // Destination currency (EUR): -4600 (external, account null) and +4600 (account on EUR)
    const eurExternalLeg = postingRows.rows.find(
      (r) => r.currency === 'EUR' && r.leg_kind === 'external',
    );
    const eurAccountLeg = postingRows.rows.find(
      (r) => r.currency === 'EUR' && r.leg_kind === 'account',
    );

    expect(eurExternalLeg).toBeDefined();
    expect(eurExternalLeg?.account_id).toBeNull();
    expect(eurExternalLeg?.amount_minor).toBe('-4600');
    expect(eurExternalLeg?.transaction_id).toBeNull();
    expect(eurExternalLeg?.status).toBe('confirmed');

    expect(eurAccountLeg).toBeDefined();
    expect(eurAccountLeg?.account_id).toBe(accountActiveEURId);
    expect(eurAccountLeg?.amount_minor).toBe('4600');
    expect(eurAccountLeg?.transaction_id).toBeNull();
    expect(eurAccountLeg?.status).toBe('confirmed');

    // Balance arithmetic: each currency group sums to 0 with at least 2 legs
    const sumResult = await admin.query<{
      currency: string;
      sum: string;
      count: string;
    }>(
      `select currency, sum(amount_minor)::text as sum, count(*)::text as count
       from public.ledger_postings
       where transfer_id = $1::uuid
       group by currency`,
      [created.id],
    );

    expect(sumResult.rows).toHaveLength(2);
    for (const row of sumResult.rows) {
      expect(row.sum).toBe('0');
      expect(Number(row.count)).toBe(2);
    }
  });

  it('201 header persistence: transfer row stores both amounts, both currencies, executedRate and referenceRate', async () => {
    const key = '00000000-0000-4000-8000-000000003002';
    const command: CreateCurrencyExchangeCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveEURId,
      sourceAmount: { amountMinor: '10000', currency: 'USD' },
      destinationAmount: { amountMinor: '9200', currency: 'EUR' },
      executedRate: '0.9200',
      referenceRate: '0.9180',
      occurredAt: '2026-08-25T11:00:00.000Z',
      fee: { amountMinor: '25', currency: 'USD' },
      description: 'Exchange with fee and reference rate',
    };

    const outcome = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED);
    const created = (outcome as CurrencyExchangeCreateCreated).transfer;

    expect(created.sourceAmount).toEqual({
      amountMinor: '10000',
      currency: 'USD',
    });
    expect(created.destinationAmount).toEqual({
      amountMinor: '9200',
      currency: 'EUR',
    });
    expect(created.exchangeRate).toBe('0.9200');
    expect(created.referenceRate).toBe('0.9180');
    expect(created.fee).toEqual({ amountMinor: '25', currency: 'USD' });

    // Direct DB row verification
    const transferRows = await admin.query(
      `select * from public.transfers where id = $1::uuid`,
      [created.id],
    );
    expect(transferRows.rows.length).toBe(1);
    const row = transferRows.rows[0];
    expect(row.workspace_id).toBe(workspace1Id);
    expect(row.source_account_id).toBe(accountActiveUSD1Id);
    expect(row.destination_account_id).toBe(accountActiveEURId);
    expect(row.source_amount_minor).toBe('10000');
    expect(row.source_currency).toBe('USD');
    expect(row.destination_amount_minor).toBe('9200');
    expect(row.destination_currency).toBe('EUR');
    expect(row.exchange_rate).toBe('0.9200');
    expect(row.reference_rate).toBe('0.9180');
    expect(row.fee_amount_minor).toBe('25');
    expect(row.fee_currency).toBe('USD');
    expect(row.status).toBe('confirmed');
    expect(row.transaction_id).toBeNull();
  });

  it('refuses a same-currency account pair with CURRENCY_MISMATCH', async () => {
    const key = '00000000-0000-4000-8000-000000003003';
    const command: CreateCurrencyExchangeCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveUSD2Id,
      sourceAmount: { amountMinor: '1000', currency: 'USD' },
      destinationAmount: { amountMinor: '1000', currency: 'USD' },
      executedRate: '1.0000',
      occurredAt: '2026-08-25T12:00:00.000Z',
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
    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
    );

    const after = await admin.query(
      `select count(*)::text as count from public.transfers where workspace_id = $1::uuid`,
      [workspace1Id],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('refuses a mismatched sourceAmount currency with CURRENCY_MISMATCH', async () => {
    const key = '00000000-0000-4000-8000-000000003004';
    const command: CreateCurrencyExchangeCommand = {
      sourceAccountId: accountActiveUSD1Id, // Account currency is USD
      destinationAccountId: accountActiveEURId, // Account currency is EUR
      sourceAmount: { amountMinor: '1000', currency: 'EUR' }, // Mismatched: EUR instead of USD
      destinationAmount: { amountMinor: '920', currency: 'EUR' },
      executedRate: '0.9200',
      occurredAt: '2026-08-25T13:00:00.000Z',
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
    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
    );

    const after = await admin.query(
      `select count(*)::text as count from public.transfers where workspace_id = $1::uuid`,
      [workspace1Id],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('refuses 403 for a viewer and blocks persistence with 0 rows written', async () => {
    const key = '00000000-0000-4000-8000-000000003005';
    const command: CreateCurrencyExchangeCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveEURId,
      sourceAmount: { amountMinor: '9999', currency: 'USD' },
      destinationAmount: { amountMinor: '9199', currency: 'EUR' },
      executedRate: '0.9200',
      occurredAt: '2026-08-25T14:00:00.000Z',
      description: 'Viewer Exchange Attempt',
    };

    const outcome = await service.create(
      subjectViewer,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN);

    const rows = await admin.query(
      `select count(*) from public.transfers where workspace_id = $1 and source_amount_minor = 9999`,
      [workspace1Id],
    );
    expect(Number(rows.rows[0].count)).toBe(0);
  });

  it('idempotent replay returns stored response and does not duplicate transfer or posting rows', async () => {
    const key = '00000000-0000-4000-8000-000000003006';
    const command: CreateCurrencyExchangeCommand = {
      sourceAccountId: accountActiveUSD1Id,
      destinationAccountId: accountActiveEURId,
      sourceAmount: { amountMinor: '7500', currency: 'USD' },
      destinationAmount: { amountMinor: '6900', currency: 'EUR' },
      executedRate: '0.9200',
      occurredAt: '2026-08-25T15:00:00.000Z',
      description: 'Idempotent Exchange',
    };

    const first = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(first.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED);
    const firstTransfer = (first as CurrencyExchangeCreateCreated).transfer;

    const second = await service.create(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(second.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.REPLAYED);
    const replayed = second as CurrencyExchangeCreateReplayed;
    expect(replayed.status).toBe(201);
    expect((replayed.body as { id: string }).id).toBe(firstTransfer.id);

    // Verify only 1 transfer row with this id exists
    const rows = await admin.query(
      `select count(*) from public.transfers where workspace_id = $1 and id = $2::uuid`,
      [workspace1Id, firstTransfer.id],
    );
    expect(Number(rows.rows[0].count)).toBe(1);

    // Verify exactly 4 posting rows for this transfer exist
    const postingCount = await admin.query(
      `select count(*) from public.ledger_postings where transfer_id = $1::uuid`,
      [firstTransfer.id],
    );
    expect(Number(postingCount.rows[0].count)).toBe(4);
  });

  it('unfiltered transaction search never returns currency exchange records because exchanges never write to public.transactions', async () => {
    const wsIsoId = id(879);
    const acc1IsoId = id(7191);
    const acc2IsoId = id(7192);

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Exchange Isolation Workspace', 'shared', 'USD', null)`,
      [wsIsoId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsIsoId, subjectOwner],
    );

    // Seed exchange rate for EUR in isolation workspace first
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values ($1, 'EUR', 'USD', 1.0800, '2026-08-01T00:00:00.000Z', 'manual', $2)`,
      [wsIsoId, subjectOwner],
    );

    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, 'Iso USD Acc', 'checking', 'USD', 'active', null, $3),
              ($4, $2, 'Iso EUR Acc', 'savings', 'EUR', 'active', null, $3)`,
      [acc1IsoId, wsIsoId, subjectOwner, acc2IsoId],
    );

    try {
      const exchangeKey = '00000000-0000-4000-8000-000000003007';
      const exchangeOutcome = await service.create(
        subjectOwner,
        wsIsoId,
        {
          sourceAccountId: acc1IsoId,
          destinationAccountId: acc2IsoId,
          sourceAmount: { amountMinor: '8888', currency: 'USD' },
          destinationAmount: { amountMinor: '8177', currency: 'EUR' },
          executedRate: '0.9200',
          occurredAt: '2026-08-25T16:00:00.000Z',
          description: 'Isolated Exchange',
        },
        exchangeKey,
      );
      expect(exchangeOutcome.kind).toBe(
        CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED,
      );
      const createdTransfer = (exchangeOutcome as CurrencyExchangeCreateCreated)
        .transfer;

      const listOutcome = await transactionService.list(subjectOwner, {
        workspaceId: wsIsoId,
        limit: 50,
      });

      expect(listOutcome.kind).toBe('ok');
      if (listOutcome.kind === 'ok') {
        expect(listOutcome.page.items).toHaveLength(0);
        const found = listOutcome.page.items.find(
          (t) => t.id === createdTransfer.id || t.amount.amountMinor === '8888',
        );
        expect(found).toBeUndefined();
      }

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
