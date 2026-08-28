import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXCHANGE_RATE_CREATE_OUTCOMES,
  type CreateManualExchangeRateCommand,
  type ExchangeRateCreateCreated,
  type ExchangeRateCreateReplayed,
} from '../../src/currencies/exchange-rate.port.js';
import { ExchangeRateService } from '../../src/currencies/exchange-rate.service.js';
import { PostgresExchangeRateAdapter } from '../../src/currencies/postgres-exchange-rate.adapter.js';
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

describe('ExchangeRateService createManualExchangeRate database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: ExchangeRateService;

  const subjectOwner = subject(861);
  const subjectAdmin = subject(862);
  const subjectEditor = subject(863);
  const subjectViewer = subject(864);
  const subjectNonMember = subject(865);

  const workspace1Id = id(881);
  const workspace2Id = id(882);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new ExchangeRateService(
      transaction,
      new PostgresExchangeRateAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
      [
        subjectOwner,
        'rate-owner@example.test',
        subjectAdmin,
        'rate-admin@example.test',
        subjectEditor,
        'rate-editor@example.test',
        subjectViewer,
        'rate-viewer@example.test',
        subjectNonMember,
        'rate-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectOwner, 'rate-owner@example.test', 'Rate Owner'],
      [subjectAdmin, 'rate-admin@example.test', 'Rate Admin'],
      [subjectEditor, 'rate-editor@example.test', 'Rate Editor'],
      [subjectViewer, 'rate-viewer@example.test', 'Rate Viewer'],
      [subjectNonMember, 'rate-nonmember@example.test', 'Rate Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Exchange Rates Workspace One'],
      [workspace2Id, 'Exchange Rates Workspace Two'],
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
  });

  afterAll(async () => {
    await admin.query(
      `delete from public.exchange_rates where workspace_id in ($1, $2)`,
      [workspace1Id, workspace2Id],
    );
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

  it('201 happy path: owner creates manual exchange rate, writes public.exchange_rates row with source = "manual", manual = true, and notes persisted', async () => {
    const key = '00000000-0000-4000-8000-000000002001';
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9200',
      effectiveAt: '2026-08-28T10:00:00.000Z',
      notes: 'Owner manual rate entry',
    };

    const outcome = await service.createManual(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);
    const created = (outcome as ExchangeRateCreateCreated).exchangeRate;
    expect(created.id).toBeDefined();
    expect(created.baseCurrency).toBe('USD');
    expect(created.quoteCurrency).toBe('EUR');
    expect(created.rate).toBe('0.92');
    expect(created.effectiveAt).toBe('2026-08-28T10:00:00.000Z');
    expect(created.source).toBe('manual');
    expect(created.manual).toBe(true);
    // D2: notes is omitted from read projection
    expect('notes' in created).toBe(false);

    // Verify public.exchange_rates row in DB
    const rows = await admin.query<{
      id: string;
      workspace_id: string;
      base_currency: string;
      quote_currency: string;
      rate: string;
      effective_at: Date;
      source: string;
      manual: boolean;
      notes: string | null;
      created_by: string;
    }>(`select * from public.exchange_rates where id = $1::uuid`, [created.id]);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row.workspace_id).toBe(workspace1Id);
    expect(row.base_currency).toBe('USD');
    expect(row.quote_currency).toBe('EUR');
    expect(row.rate).toBe('0.92');
    expect(row.source).toBe('manual');
    expect(row.manual).toBe(true);
    expect(row.notes).toBe('Owner manual rate entry');
    expect(row.created_by).toBe(subjectOwner);
  });

  it('201 editor creates manual exchange rate', async () => {
    const key = '00000000-0000-4000-8000-000000002002';
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'GBP',
      rate: '0.7800',
      effectiveAt: '2026-08-28T11:00:00.000Z',
      notes: 'Editor rate entry',
    };

    const outcome = await service.createManual(
      subjectEditor,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);
    const created = (outcome as ExchangeRateCreateCreated).exchangeRate;
    expect(created.source).toBe('manual');
    expect(created.manual).toBe(true);
  });

  it('201 administrator creates manual exchange rate', async () => {
    const key = '00000000-0000-4000-8000-000000002003';
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'JPY',
      rate: '155.5000',
      effectiveAt: '2026-08-28T12:00:00.000Z',
    };

    const outcome = await service.createManual(
      subjectAdmin,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);
    const created = (outcome as ExchangeRateCreateCreated).exchangeRate;
    expect(created.rate).toBe('155.5');
  });

  it('403 forbidden: viewer role is refused by service and blocks persistence (0 rows written)', async () => {
    const key = '00000000-0000-4000-8000-000000002004';
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'CAD',
      rate: '1.3500',
      effectiveAt: '2026-08-28T13:00:00.000Z',
      notes: 'Viewer rate attempt',
    };

    const outcome = await service.createManual(
      subjectViewer,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN);

    const rows = await admin.query(
      `select count(*) from public.exchange_rates where workspace_id = $1 and quote_currency = 'CAD'`,
      [workspace1Id],
    );
    expect(Number(rows.rows[0].count)).toBe(0);
  });

  it('403 forbidden: non-member is refused', async () => {
    const key = '00000000-0000-4000-8000-000000002005';
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'CHF',
      rate: '0.8800',
      effectiveAt: '2026-08-28T14:00:00.000Z',
    };

    const outcome = await service.createManual(
      subjectNonMember,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN);
  });

  it('409 conflict when rate already exists for same (workspace, base, quote, effective_at)', async () => {
    const key1 = '00000000-0000-4000-8000-000000002006';
    const key2 = '00000000-0000-4000-8000-000000002007';
    const timestamp = '2026-08-28T15:00:00.000Z';

    const command1: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'MXN',
      rate: '19.5000',
      effectiveAt: timestamp,
      notes: 'First MXN rate',
    };

    const first = await service.createManual(
      subjectOwner,
      workspace1Id,
      command1,
      key1,
    );
    expect(first.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);

    const command2: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'MXN',
      rate: '19.6000',
      effectiveAt: timestamp,
      notes: 'Duplicate MXN rate attempt',
    };

    const second = await service.createManual(
      subjectOwner,
      workspace1Id,
      command2,
      key2,
    );
    expect(second.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.ALREADY_RECORDED);

    const countRes = await admin.query<{ count: string }>(
      `select count(*)::text as count from public.exchange_rates where workspace_id = $1 and base_currency = 'USD' and quote_currency = 'MXN'`,
      [workspace1Id],
    );
    expect(countRes.rows[0].count).toBe('1');
  });

  it('idempotent replay returns stored response and does not duplicate exchange_rates rows', async () => {
    const key = '00000000-0000-4000-8000-000000002008';
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'BRL',
      rate: '5.5000',
      effectiveAt: '2026-08-28T16:00:00.000Z',
      notes: 'Idempotent BRL rate',
    };

    const first = await service.createManual(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(first.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);
    const firstRate = (first as ExchangeRateCreateCreated).exchangeRate;

    const second = await service.createManual(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(second.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.REPLAYED);
    const replayed = second as ExchangeRateCreateReplayed;
    expect(replayed.status).toBe(201);
    expect((replayed.body as { id: string }).id).toBe(firstRate.id);

    const rows = await admin.query(
      `select count(*) from public.exchange_rates where workspace_id = $1 and id = $2::uuid`,
      [workspace1Id, firstRate.id],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('idempotent conflict: reusing idempotency key with different payload returns IDEMPOTENCY_CONFLICT', async () => {
    const key = '00000000-0000-4000-8000-000000002009';
    const command1: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'CLP',
      rate: '950.0000',
      effectiveAt: '2026-08-28T17:00:00.000Z',
    };

    const first = await service.createManual(
      subjectOwner,
      workspace1Id,
      command1,
      key,
    );
    expect(first.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);

    const command2: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'CLP',
      rate: '960.0000',
      effectiveAt: '2026-08-28T17:00:00.000Z',
    };

    const second = await service.createManual(
      subjectOwner,
      workspace1Id,
      command2,
      key,
    );
    expect(second.kind).toBe(
      EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    );
  });

  it('persists 500-char notes to database and read projection deliberately omits it', async () => {
    const key = '00000000-0000-4000-8000-000000002010';
    const notes500 = 'x'.repeat(500);
    const command: CreateManualExchangeRateCommand = {
      baseCurrency: 'USD',
      quoteCurrency: 'COP',
      rate: '4100.0000',
      effectiveAt: '2026-08-28T18:00:00.000Z',
      notes: notes500,
    };

    const outcome = await service.createManual(
      subjectOwner,
      workspace1Id,
      command,
      key,
    );
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);
    const created = (outcome as ExchangeRateCreateCreated).exchangeRate;

    // D2: notes is deliberately omitted from read projection
    expect('notes' in created).toBe(false);

    const rows = await admin.query<{ notes: string }>(
      `select notes from public.exchange_rates where id = $1::uuid`,
      [created.id],
    );
    expect(rows.rows[0].notes).toBe(notes500);
    expect(rows.rows[0].notes.length).toBe(500);
  });
});
