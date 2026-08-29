import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXCHANGE_RATE_LIST_OUTCOMES,
  type ExchangeRate,
  type ExchangeRateListOk,
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

describe('ExchangeRateService listExchangeRates database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: ExchangeRateService;

  const subjectOwner = subject(871);
  const subjectViewer = subject(872);
  const subjectNonMember = subject(873);
  const subjectForeignOwner = subject(874);

  const workspace1Id = id(891);
  const foreignWorkspaceId = id(892);
  const absentWorkspaceId = id(899);

  // Microsecond seeds for workspace 1 with mixed timestamps and UUID tie-breaking
  // Expected order by (effective_at desc, id desc):
  // 1. rate8005: 2026-08-28T18:00:00.000000Z (EUR/USD, 1.0850)
  // 2. rate8003: 2026-08-25T14:00:00.000000Z (USD/EUR, 0.9250)
  // 3. rate8002: 2026-08-20T10:00:00.000000Z (USD/GBP, 0.7800) -> tied effective_at with rate8001, id 8002 > 8001
  // 4. rate8001: 2026-08-20T10:00:00.000000Z (USD/EUR, 0.9200) -> tied effective_at with rate8002, id 8001 < 8002
  // 5. rate8004: 2026-08-15T08:00:00.000000Z (USD/JPY, 155.5000)
  const rate8001 = id(8001);
  const rate8002 = id(8002);
  const rate8003 = id(8003);
  const rate8004 = id(8004);
  const rate8005 = id(8005);
  const foreignRateId = id(8099);

  const expectedDefaultOrder = [
    rate8005,
    rate8003,
    rate8002,
    rate8001,
    rate8004,
  ];

  async function listRates(
    subjectId: string,
    wsId: string,
    options: {
      readonly baseCurrency?: string;
      readonly quoteCurrency?: string;
      readonly from?: string;
      readonly to?: string;
    } = {},
  ): Promise<
    | {
        readonly kind: typeof EXCHANGE_RATE_LIST_OUTCOMES.OK;
        readonly rates: readonly ExchangeRate[];
        readonly ids: readonly string[];
      }
    | { readonly kind: typeof EXCHANGE_RATE_LIST_OUTCOMES.FORBIDDEN }
  > {
    const outcome = await service.list(subjectId, {
      workspaceId: wsId,
      ...(options.baseCurrency === undefined
        ? {}
        : { baseCurrency: options.baseCurrency }),
      ...(options.quoteCurrency === undefined
        ? {}
        : { quoteCurrency: options.quoteCurrency }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
    });

    if (outcome.kind === EXCHANGE_RATE_LIST_OUTCOMES.FORBIDDEN) return outcome;
    const ok = outcome as ExchangeRateListOk;
    return {
      kind: ok.kind,
      rates: ok.exchangeRates,
      ids: ok.exchangeRates.map((r) => r.id),
    };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new ExchangeRateService(
      transaction,
      new PostgresExchangeRateAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
      [
        subjectOwner,
        'rate-list-owner@example.test',
        subjectViewer,
        'rate-list-viewer@example.test',
        subjectNonMember,
        'rate-list-nonmember@example.test',
        subjectForeignOwner,
        'rate-list-foreign@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectOwner, 'rate-list-owner@example.test', 'Rate List Owner'],
      [subjectViewer, 'rate-list-viewer@example.test', 'Rate List Viewer'],
      [
        subjectNonMember,
        'rate-list-nonmember@example.test',
        'Rate List Non Member',
      ],
      [
        subjectForeignOwner,
        'rate-list-foreign@example.test',
        'Rate List Foreign Owner',
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
      [workspace1Id, 'Rate List Workspace One'],
      [foreignWorkspaceId, 'Rate List Foreign Workspace'],
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
              ($1, $3, 'viewer', 'active'),
              ($4, $5, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectViewer,
        foreignWorkspaceId,
        subjectForeignOwner,
      ],
    );

    // 5. Seed exchange rates in workspace 1
    const seeds = [
      {
        id: rate8001,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.9200',
        effectiveAt: '2026-08-20T10:00:00.000Z',
        source: 'manual',
        manual: true,
        notes: 'Seed rate 8001',
      },
      {
        id: rate8002,
        baseCurrency: 'USD',
        quoteCurrency: 'GBP',
        rate: '0.7800',
        effectiveAt: '2026-08-20T10:00:00.000Z', // identical timestamp to rate8001
        source: 'manual',
        manual: true,
        notes: 'Seed rate 8002',
      },
      {
        id: rate8003,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.9250',
        effectiveAt: '2026-08-25T14:00:00.000Z',
        source: 'manual',
        manual: true,
        notes: 'Seed rate 8003',
      },
      {
        id: rate8004,
        baseCurrency: 'USD',
        quoteCurrency: 'JPY',
        rate: '155.5000',
        effectiveAt: '2026-08-15T08:00:00.000Z',
        source: 'manual',
        manual: true,
        notes: 'Seed rate 8004',
      },
      {
        id: rate8005,
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '1.0850',
        effectiveAt: '2026-08-28T18:00:00.000Z',
        source: 'manual',
        manual: true,
        notes: 'Seed rate 8005',
      },
    ];

    for (const s of seeds) {
      await admin.query(
        `insert into public.exchange_rates (id, workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, notes, created_by)
         values ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::timestamptz, $7, $8, $9, $10::uuid)`,
        [
          s.id,
          workspace1Id,
          s.baseCurrency,
          s.quoteCurrency,
          s.rate,
          s.effectiveAt,
          s.source,
          s.manual,
          s.notes,
          subjectOwner,
        ],
      );
    }

    // 6. Seed foreign rate in foreign workspace
    await admin.query(
      `insert into public.exchange_rates (id, workspace_id, base_currency, quote_currency, rate, effective_at, source, manual, notes, created_by)
       values ($1::uuid, $2::uuid, 'USD', 'CHF', '0.8900'::numeric, '2026-08-28T12:00:00.000Z'::timestamptz, 'manual', true, 'Foreign rate', $3::uuid)`,
      [foreignRateId, foreignWorkspaceId, subjectForeignOwner],
    );
  });

  afterAll(async () => {
    await admin.query(
      `delete from public.exchange_rates where workspace_id in ($1, $2)`,
      [workspace1Id, foreignWorkspaceId],
    );
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      workspace1Id,
      foreignWorkspaceId,
    ]);
    await admin.query(`delete from auth.users where id in ($1, $2, $3, $4)`, [
      subjectOwner,
      subjectViewer,
      subjectNonMember,
      subjectForeignOwner,
    ]);
    await pool.end();
    await admin.end();
  });

  it('200 happy path: returns all rates for workspace in effective_at desc, id desc order, with preserved numeric scale and omitted notes (D1, D2, D6)', async () => {
    const outcome = await listRates(subjectOwner, workspace1Id);
    expect(outcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (outcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;

    expect(outcome.ids).toEqual(expectedDefaultOrder);

    // D2: Prove tie-break on id desc: rate8002 and rate8001 have identical effective_at,
    // but rate8002 (ending in 8002) > rate8001 (ending in 8001), so rate8002 MUST precede rate8001.
    const r2Index = outcome.ids.indexOf(rate8002);
    const r1Index = outcome.ids.indexOf(rate8001);
    expect(r2Index).toBeLessThan(r1Index);
    expect(outcome.rates[r2Index].effectiveAt).toBe(
      outcome.rates[r1Index].effectiveAt,
    );

    // D6: Rate string preserves exact database numeric scale without renormalisation
    const r1 = outcome.rates.find((r) => r.id === rate8001);
    expect(r1?.rate).toBe('0.9200');
    const r4 = outcome.rates.find((r) => r.id === rate8004);
    expect(r4?.rate).toBe('155.5000');

    // Notes field is omitted from read projection
    for (const r of outcome.rates) {
      expect('notes' in r).toBe(false);
    }
  });

  it('filters by baseCurrency alone (D3)', async () => {
    const usdOutcome = await listRates(subjectOwner, workspace1Id, {
      baseCurrency: 'USD',
    });
    expect(usdOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (usdOutcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(usdOutcome.ids).toEqual([rate8003, rate8002, rate8001, rate8004]);

    const eurOutcome = await listRates(subjectOwner, workspace1Id, {
      baseCurrency: 'EUR',
    });
    expect(eurOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (eurOutcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(eurOutcome.ids).toEqual([rate8005]);
  });

  it('filters by quoteCurrency alone (D3)', async () => {
    const eurQuote = await listRates(subjectOwner, workspace1Id, {
      quoteCurrency: 'EUR',
    });
    expect(eurQuote.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (eurQuote.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(eurQuote.ids).toEqual([rate8003, rate8001]);

    const jpyQuote = await listRates(subjectOwner, workspace1Id, {
      quoteCurrency: 'JPY',
    });
    expect(jpyQuote.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (jpyQuote.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(jpyQuote.ids).toEqual([rate8004]);
  });

  it('filters by baseCurrency and quoteCurrency combined (D3)', async () => {
    const pairOutcome = await listRates(subjectOwner, workspace1Id, {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
    });
    expect(pairOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (pairOutcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(pairOutcome.ids).toEqual([rate8003, rate8001]);
  });

  it('filters by from and to date range with inclusive boundaries (D3)', async () => {
    // Range 2026-08-20 to 2026-08-25: includes rate8003 (Aug 25), rate8002 (Aug 20), rate8001 (Aug 20)
    const rangeOutcome = await listRates(subjectOwner, workspace1Id, {
      from: '2026-08-20',
      to: '2026-08-25',
    });
    expect(rangeOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (rangeOutcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(rangeOutcome.ids).toEqual([rate8003, rate8002, rate8001]);

    // Single-day boundary 2026-08-28: includes rate8005 (Aug 28 18:00 UTC)
    const singleDay = await listRates(subjectOwner, workspace1Id, {
      from: '2026-08-28',
      to: '2026-08-28',
    });
    expect(singleDay.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (singleDay.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(singleDay.ids).toEqual([rate8005]);
  });

  it('filters by all 4 parameters combined (D3)', async () => {
    const combined = await listRates(subjectOwner, workspace1Id, {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      from: '2026-08-20',
      to: '2026-08-20',
    });
    expect(combined.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (combined.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(combined.ids).toEqual([rate8001]);
  });

  it('returns empty array when query matches no exchange rates (200 OK, not error)', async () => {
    const emptyOutcome = await listRates(subjectOwner, workspace1Id, {
      baseCurrency: 'CAD',
    });
    expect(emptyOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (emptyOutcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(emptyOutcome.ids).toEqual([]);
  });

  it('admits a viewer because select policy admits all workspace roles (D4)', async () => {
    const viewerOutcome = await listRates(subjectViewer, workspace1Id);
    expect(viewerOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (viewerOutcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(viewerOutcome.ids).toEqual(expectedDefaultOrder);
  });

  it('refuses a non-member with FORBIDDEN (D4)', async () => {
    const nonMemberOutcome = await listRates(subjectNonMember, workspace1Id);
    expect(nonMemberOutcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.FORBIDDEN);
  });

  it('isolation vacuity guard: caller with no active role in foreign workspace gets 403 (target workspace genuinely contains rows) (D4)', async () => {
    // Confirm foreign workspace genuinely contains rate rows
    const foreignCount = await admin.query<{ count: string }>(
      'select count(*) as count from public.exchange_rates where workspace_id = $1::uuid',
      [foreignWorkspaceId],
    );
    expect(Number(foreignCount.rows[0]?.count)).toBeGreaterThan(0);

    // subjectOwner has no role in foreignWorkspaceId -> MUST get FORBIDDEN (403), not 200 []
    const outcome = await listRates(subjectOwner, foreignWorkspaceId);
    expect(outcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.FORBIDDEN);
  });

  it('refuses an absent workspace with 403 to prevent leaking existence', async () => {
    const outcome = await listRates(subjectOwner, absentWorkspaceId);
    expect(outcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.FORBIDDEN);
  });

  it('workspace isolation: foreign workspace rates never leak into workspace 1 queries (RLS)', async () => {
    const outcome = await listRates(subjectOwner, workspace1Id);
    expect(outcome.kind).toBe(EXCHANGE_RATE_LIST_OUTCOMES.OK);
    if (outcome.kind !== EXCHANGE_RATE_LIST_OUTCOMES.OK) return;
    expect(outcome.ids).not.toContain(foreignRateId);
  });
});
