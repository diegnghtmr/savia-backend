import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_BALANCE_OUTCOMES,
  type AccountBalanceOk,
} from '../../src/accounts/accounts.port.js';
import { AccountsService } from '../../src/accounts/accounts.service.js';
import { PostgresAccountsAdapter } from '../../src/accounts/postgres-accounts.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('AccountsService getAccountBalance database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: AccountsService;
  let adapter: PostgresAccountsAdapter;

  const subjectDualMember = subject(900);
  const subjectViewer = subject(901);
  const subjectNonMember = subject(902);

  const workspace1Id = id(951);
  const workspace2Id = id(952);
  const absentWorkspaceId = id(999);

  const accountBucketMathId = id(3001);
  const accountDraftOnlyId = id(3002);
  const accountAsOfId = id(3003);
  const accountPrecisionId = id(3004);
  const accountW2Id = id(3005);
  const accountForeignEURId = id(3006);
  const absentAccountId = id(9999);

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error('DATABASE_URL is required for integration tests.');

    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    adapter = new PostgresAccountsAdapter();
    service = new AccountsService(
      transaction,
      adapter,
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users and profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)`,
      [
        subjectDualMember,
        'balance-dual@example.test',
        subjectViewer,
        'balance-viewer@example.test',
        subjectNonMember,
        'balance-nonmember@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [subjectDualMember, 'balance-dual@example.test', 'Balance Dual Member'],
      [subjectViewer, 'balance-viewer@example.test', 'Balance Viewer'],
      [
        subjectNonMember,
        'balance-nonmember@example.test',
        'Balance Non Member',
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
      [workspace1Id, 'Balance Workspace One'],
      [workspace2Id, 'Balance Workspace Two'],
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
              ($3, $2, 'owner', 'active'),
              ($1, $4, 'viewer', 'active')`,
      [workspace1Id, subjectDualMember, workspace2Id, subjectViewer],
    );

    // 3.5 Exchange Rates (seed order matters: rate must precede foreign-currency account)
    await admin.query(
      `insert into public.exchange_rates
         (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values
         ($1, 'EUR', 'USD', 1.0800, '2026-07-01T00:00:00.000Z', 'ecb', $2),
         ($1, 'EUR', 'USD', 1.1000, '2026-07-20T00:00:00.000Z', 'reuters', $2)`,
      [workspace1Id, subjectDualMember],
    );

    // 4. Accounts
    await admin.query(
      `insert into public.accounts
         (id, workspace_id, name, type, currency, status, include_in_net_worth, created_by, created_at, updated_at, version)
       values
         ($1, $2, 'Bucket Math Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1),
         ($4, $2, 'Draft Only Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1),
         ($5, $2, 'AsOf Cutoff Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1),
         ($6, $2, 'Precision Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1),
         ($7, $8, 'Foreign Workspace 2 Account', 'checking', 'USD', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1),
         ($9, $2, 'Foreign EUR Account', 'checking', 'EUR', 'active', true, $3, '2026-07-01T00:00:00.000Z'::timestamptz, '2026-07-01T00:00:00.000Z'::timestamptz, 1)`,
      [
        accountBucketMathId,
        workspace1Id,
        subjectDualMember,
        accountDraftOnlyId,
        accountAsOfId,
        accountPrecisionId,
        accountW2Id,
        workspace2Id,
        accountForeignEURId,
      ],
    );

    // 5. Seed balanced transactions and ledger postings
    // Helper to seed a balanced transaction pair (account leg + external counter leg)
    // Helper to seed a balanced transaction pair (account leg + external counter leg)
    const seedPosting = async (
      txnId: string,
      accId: string,
      wsId: string,
      status: 'draft' | 'pending' | 'confirmed' | 'reconciled',
      amountMinor: string,
      occurredAt: string,
      currency: string = 'USD',
    ) => {
      await admin.query(
        `insert into public.transactions (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, description, created_by)
         values ($1::uuid, $2::uuid, $3::uuid, 'adjustment', $4, $5, $8, $6::timestamptz, 'Seed posting', $7::uuid)`,
        [
          txnId,
          wsId,
          accId,
          status,
          amountMinor,
          occurredAt,
          subjectDualMember,
          currency,
        ],
      );

      const negAmount = amountMinor.startsWith('-')
        ? amountMinor.slice(1)
        : `-${amountMinor}`;

      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values
           ($1::uuid, $2::uuid, $3::uuid, 'account', $4, $8, $5, $6::timestamptz),
           ($1::uuid, $2::uuid, null, 'external', $7, $8, $5, $6::timestamptz)`,
        [
          wsId,
          txnId,
          accId,
          amountMinor,
          status,
          occurredAt,
          negAmount,
          currency,
        ],
      );
    };

    // Account 1 (Bucket Math): 4 distinct amounts for 4 statuses
    // Draft: 1000, Pending: 2000, Confirmed: 4000, Reconciled: 8000
    await seedPosting(
      id(4001),
      accountBucketMathId,
      workspace1Id,
      'draft',
      '1000',
      '2026-07-01T12:00:00.000Z',
    );
    await seedPosting(
      id(4002),
      accountBucketMathId,
      workspace1Id,
      'pending',
      '2000',
      '2026-07-02T12:00:00.000Z',
    );
    await seedPosting(
      id(4003),
      accountBucketMathId,
      workspace1Id,
      'confirmed',
      '4000',
      '2026-07-03T12:00:00.000Z',
    );
    await seedPosting(
      id(4004),
      accountBucketMathId,
      workspace1Id,
      'reconciled',
      '8000',
      '2026-07-04T12:00:00.000Z',
    );

    // Account 2 (Draft Only): only draft postings
    await seedPosting(
      id(4005),
      accountDraftOnlyId,
      workspace1Id,
      'draft',
      '5000',
      '2026-07-01T12:00:00.000Z',
    );

    // Account 3 (AsOf Cutoff): postings before and after 2026-07-15
    await seedPosting(
      id(4006),
      accountAsOfId,
      workspace1Id,
      'confirmed',
      '3000',
      '2026-07-10T12:00:00.000Z',
    );
    await seedPosting(
      id(4007),
      accountAsOfId,
      workspace1Id,
      'confirmed',
      '7000',
      '2026-07-20T12:00:00.000Z',
    );

    // Account 4 (Precision): confirmed postings summing past 2^53 (9007199254740992)
    await seedPosting(
      id(4008),
      accountPrecisionId,
      workspace1Id,
      'confirmed',
      '9007199254740993',
      '2026-07-01T12:00:00.000Z',
    );
    await seedPosting(
      id(4009),
      accountPrecisionId,
      workspace1Id,
      'confirmed',
      '100',
      '2026-07-02T12:00:00.000Z',
    );

    // Account 6 (Foreign EUR): postings before and after 2026-07-20
    await seedPosting(
      id(4010),
      accountForeignEURId,
      workspace1Id,
      'confirmed',
      '5000',
      '2026-07-10T12:00:00.000Z',
      'EUR',
    );
    await seedPosting(
      id(4011),
      accountForeignEURId,
      workspace1Id,
      'confirmed',
      '5000',
      '2026-07-25T12:00:00.000Z',
      'EUR',
    );
  });

  afterAll(async () => {
    await admin.end();
    await transaction.close();
  });

  it('1. asserts availableBalance key is ABSENT from the response (RULING 31)', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountBucketMathId,
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const body = (outcome as AccountBalanceOk).balance;
    expect('availableBalance' in body).toBe(false);
  });

  it('2. calculates bucket math with four distinct amounts (confirmed+reconciled, pending, reconciled, draft excluded)', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountBucketMathId,
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const balance = (outcome as AccountBalanceOk).balance;

    // Confirmed (4000) + Reconciled (8000) = 12000
    expect(balance.nativeBalance).toEqual({
      amountMinor: '12000',
      currency: 'USD',
    });
    // Pending (2000) only
    expect(balance.pendingBalance).toEqual({
      amountMinor: '2000',
      currency: 'USD',
    });
    // Reconciled (8000) only
    expect(balance.reconciledBalance).toEqual({
      amountMinor: '8000',
      currency: 'USD',
    });
  });

  it('3. draft contributes to nothing — draft-only account reports "0" in every bucket', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountDraftOnlyId,
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const balance = (outcome as AccountBalanceOk).balance;

    expect(balance.nativeBalance).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });
    expect(balance.pendingBalance).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });
    expect(balance.reconciledBalance).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });
    expect(balance.baseCurrencyEquivalent.converted).toEqual({
      amountMinor: '0',
      currency: 'USD',
    });
  });

  it('4. same-currency identity — rate is "1", converted deep equals original, and rateSource is non-empty', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountBucketMathId,
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const balance = (outcome as AccountBalanceOk).balance;

    expect(balance.baseCurrencyEquivalent.rate).toBe('1');
    expect(balance.baseCurrencyEquivalent.converted).toEqual(
      balance.baseCurrencyEquivalent.original,
    );
    expect(typeof balance.baseCurrencyEquivalent.rateSource).toBe('string');
    expect(balance.baseCurrencyEquivalent.rateSource.length).toBeGreaterThan(0);
    expect(balance.baseCurrencyEquivalent.rateDate).toBeDefined();
  });

  it('5. asOf filters by date — cutoff excludes later postings, absent asOf includes all', async () => {
    // Before 2026-07-15: only 3000 is included
    const cutoffOutcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountAsOfId,
      '2026-07-15T00:00:00.000Z',
    );
    expect(cutoffOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    expect((cutoffOutcome as AccountBalanceOk).balance.nativeBalance).toEqual({
      amountMinor: '3000',
      currency: 'USD',
    });

    // Absent asOf: both 3000 and 7000 are included -> 10000
    const fullOutcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountAsOfId,
    );
    expect(fullOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    expect((fullOutcome as AccountBalanceOk).balance.nativeBalance).toEqual({
      amountMinor: '10000',
      currency: 'USD',
    });
  });

  it('7. 403 vs 404 boundary — non-member workspace -> 403; foreign account -> 404; direct adapter check returns undefined', async () => {
    // Non-member access -> 403 Forbidden
    const forbiddenOutcome = await service.readBalance(
      subjectNonMember,
      workspace1Id,
      accountBucketMathId,
    );
    expect(forbiddenOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.FORBIDDEN);

    // Absent workspace -> 403 Forbidden (indistinguishable from unauthorized)
    const absentWsOutcome = await service.readBalance(
      subjectDualMember,
      absentWorkspaceId,
      accountBucketMathId,
    );
    expect(absentWsOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.FORBIDDEN);

    // Foreign account (exists in workspace 2, queried under workspace 1) -> 404 Not Found
    const foreignOutcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountW2Id,
    );
    expect(foreignOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.NOT_FOUND);

    // Absent account under valid workspace -> 404 Not Found
    const absentAccOutcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      absentAccountId,
    );
    expect(absentAccOutcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.NOT_FOUND);

    // Direct adapter call with mismatched workspaceId proves the WHERE clause enforces row isolation
    const directResult = await transaction.runRead(
      subjectDualMember,
      async (client) =>
        adapter.readAccountBalance(client, workspace1Id, accountW2Id),
    );
    expect(directResult).toBeUndefined();
  });

  it('8. precision past 2^53 is preserved as exact string without number loss', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountPrecisionId,
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const balance = (outcome as AccountBalanceOk).balance;

    // 9007199254740993 + 100 = 9007199254741093
    expect(balance.nativeBalance.amountMinor).toBe('9007199254741093');
    expect(balance.baseCurrencyEquivalent.converted.amountMinor).toBe(
      '9007199254741093',
    );
  });

  it('9. converts cross-currency balance using recorded exchange rates with real rate, rateDate, rateSource and rounded baseCurrencyEquivalent', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountForeignEURId,
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const balance = (outcome as AccountBalanceOk).balance;

    expect(balance.nativeBalance).toEqual({
      amountMinor: '10000',
      currency: 'EUR',
    });
    expect(balance.baseCurrencyEquivalent.original).toEqual({
      amountMinor: '10000',
      currency: 'EUR',
    });
    // 10000 EUR * 1.1000 = 11000 USD
    expect(balance.baseCurrencyEquivalent.converted).toEqual({
      amountMinor: '11000',
      currency: 'USD',
    });
    expect(balance.baseCurrencyEquivalent.rate).toBe('1.1000');
    expect(balance.baseCurrencyEquivalent.rateDate).toBe('2026-07-20');
    expect(balance.baseCurrencyEquivalent.rateSource).toBe('reuters');
  });

  it('10. applies historical exchange rate matching effective asOf cutoff for cross-currency conversion', async () => {
    const outcome = await service.readBalance(
      subjectDualMember,
      workspace1Id,
      accountForeignEURId,
      '2026-07-15T00:00:00.000Z',
    );
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.OK);
    const balance = (outcome as AccountBalanceOk).balance;

    expect(balance.nativeBalance).toEqual({
      amountMinor: '5000',
      currency: 'EUR',
    });
    expect(balance.baseCurrencyEquivalent.original).toEqual({
      amountMinor: '5000',
      currency: 'EUR',
    });
    // 5000 EUR * 1.0800 = 5400 USD
    expect(balance.baseCurrencyEquivalent.converted).toEqual({
      amountMinor: '5400',
      currency: 'USD',
    });
    expect(balance.baseCurrencyEquivalent.rate).toBe('1.0800');
    expect(balance.baseCurrencyEquivalent.rateDate).toBe('2026-07-01');
    expect(balance.baseCurrencyEquivalent.rateSource).toBe('ecb');
  });
});

describe('getAccountBalance OpenAPI contract specification', () => {
  it('6. RULING 43 caveat is documented in OpenAPI mirror description', () => {
    const openapiPath = resolve(__dirname, '../../openapi/savia.openapi.yaml');
    const content = readFileSync(openapiPath, 'utf8');
    const balanceOpMatch = content.match(
      /\/v1\/accounts\/\{accountId\}\/balance:[\s\S]*?get:[\s\S]*?description:\s*([^\n]+(?:\n\s+[^\n]+)*)/,
    );
    expect(balanceOpMatch).toBeDefined();
    const description = balanceOpMatch?.[1] ?? '';
    expect(description.toLowerCase()).toContain('asof');
    expect(description.toLowerCase()).toContain('current status');
  });
});
