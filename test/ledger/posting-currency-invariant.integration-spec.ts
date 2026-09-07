// Migration under test: 202609060002_posting_currency_invariant.sql
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerModule } from '../../src/ledger/ledger.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number): string =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number): string =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

interface CapturedPgError {
  readonly code?: string;
  readonly message?: string;
  readonly constraint?: string;
}

async function capturePgError(
  run: () => Promise<unknown>,
): Promise<CapturedPgError> {
  try {
    await run();
  } catch (error: unknown) {
    return error as CapturedPgError;
  }
  throw new Error('Expected the statement to fail, but it succeeded.');
}

describe('Posting currency invariant database boundary (202609060002_posting_currency_invariant.sql)', () => {
  let admin: Pool;

  const ownerA = subject(911);
  const outsiderZ = subject(912);

  const ws1Id = id(951);
  const wsOtherId = id(952);

  const memOwnerAId = id(921);
  const memOutsiderZId = id(922);

  const accUSDId = id(7201);
  const accEURId = id(7202);
  const accOtherWsId = id(7203);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    // 1. Users & Profiles
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4)`,
      [
        ownerA,
        'posting-owner-a@example.test',
        outsiderZ,
        'posting-outsider-z@example.test',
      ],
    );

    for (const [userId, email, name] of [
      [ownerA, 'posting-owner-a@example.test', 'Posting Owner A'],
      [outsiderZ, 'posting-outsider-z@example.test', 'Posting Outsider Z'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 2. Workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Posting WS 1', 'shared', 'USD', null, $2),
              ($3, 'Posting WS Other', 'shared', 'USD', null, $4)`,
      [ws1Id, ownerA, wsOtherId, outsiderZ],
    );

    // 3. Memberships
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'owner', 'active')`,
      [memOwnerAId, ws1Id, ownerA, memOutsiderZId, wsOtherId, outsiderZ],
    );

    // 4. Exchange rates (EUR -> USD in ws1Id so EUR account is valid under account currency invariant)
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values ($1, 'EUR', 'USD', 1.1000, '2026-08-01T00:00:00.000Z', 'manual', $2)`,
      [ws1Id, ownerA],
    );

    // 5. Accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'USD Checking', 'checking', 'USD', 'active', $3),
              ($4, $5, 'EUR Checking', 'checking', 'EUR', 'active', $6),
              ($7, $8, 'Other WS USD Checking', 'checking', 'USD', 'active', $9)`,
      [
        accUSDId,
        ws1Id,
        ownerA,
        accEURId,
        ws1Id,
        ownerA,
        accOtherWsId,
        wsOtherId,
        outsiderZ,
      ],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.ledger_postings where workspace_id = any($1::uuid[])',
          [[ws1Id, wsOtherId]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.transactions where workspace_id = any($1::uuid[])',
          [[ws1Id, wsOtherId]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.accounts where workspace_id = any($1::uuid[])',
          [[ws1Id, wsOtherId]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.exchange_rates where workspace_id = any($1::uuid[])',
          [[ws1Id, wsOtherId]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.workspace_memberships where workspace_id = any($1::uuid[])',
          [[ws1Id, wsOtherId]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.workspaces where id = any($1::uuid[])', [
          [ws1Id, wsOtherId],
        ])
        .catch(() => {});
      await admin
        .query('delete from public.profiles where id = any($1::uuid[])', [
          [ownerA, outsiderZ],
        ])
        .catch(() => {});
      await admin
        .query('delete from auth.users where id = any($1::uuid[])', [
          [ownerA, outsiderZ],
        ])
        .catch(() => {});
      await admin.end();
    }
  });

  describe('Structure and Catalog metadata', () => {
    it('enforce_ledger_posting_currency_matches_account_trigger exists on public.ledger_postings with full catalog definition', async () => {
      const trigRes = await admin.query<{
        tgname: string;
        tgtype: number;
        tgenabled: string;
        proname: string;
        prosecdef: boolean;
        proowner: string;
        proconfig: readonly string[] | null;
      }>(
        `select t.tgname,
                t.tgtype,
                t.tgenabled,
                p.proname::text as proname,
                p.prosecdef,
                p.proowner::regrole::text as proowner,
                p.proconfig
           from pg_trigger t
           join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = 'public.ledger_postings'::regclass
            and t.tgname = 'enforce_ledger_posting_currency_matches_account_trigger'`,
      );
      expect(trigRes.rows).toHaveLength(1);
      const trig = trigRes.rows[0];
      expect(trig.proname).toBe(
        'enforce_ledger_posting_currency_matches_account',
      );
      expect(trig.prosecdef).toBe(true);
      expect(trig.proowner).toBe('savia_elevated');
      expect(trig.proconfig).toEqual(['search_path=pg_catalog, public']);
      expect(trig.tgenabled).toBe('O');
      // Exact tgtype mask: ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16) = 23
      expect(trig.tgtype).toBe(23);

      const colsRes = await admin.query<{ col_name: string }>(
        `select a.attname::text as col_name
           from pg_trigger t
           join pg_attribute a
             on a.attrelid = t.tgrelid
            and a.attnum = any(string_to_array(t.tgattr::text, ' ')::int2[])
          where t.tgrelid = 'public.ledger_postings'::regclass
            and t.tgname = 'enforce_ledger_posting_currency_matches_account_trigger'
          order by a.attname`,
      );
      expect(colsRes.rows.map((r) => r.col_name)).toEqual([
        'account_id',
        'currency',
        'workspace_id',
      ]);

      const privRes = await admin.query<{ public_exec_fn: boolean }>(
        `select has_function_privilege('public', 'public.enforce_ledger_posting_currency_matches_account()', 'execute') as public_exec_fn`,
      );
      expect(privRes.rows[0].public_exec_fn).toBe(false);
    });
  });

  describe('Invariant Enforcement (behavioral live proofs)', () => {
    it('refuses an account leg whose currency differs from its account, asserting constraint ledger_postings_currency_matches_account', async () => {
      const txnId = id(7301);
      await admin.query(
        `insert into public.transactions (id, workspace_id, type, account_id, amount_minor, currency, occurred_at, status, created_by)
         values ($1, $2, 'expense', $3, 5000, 'EUR', now(), 'confirmed', $4)`,
        [txnId, ws1Id, accUSDId, ownerA],
      );

      try {
        const err = await capturePgError(() =>
          admin.query(
            `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
             values ($1, $2, $3, 'account', 5000, 'EUR', 'confirmed', now())`,
            [ws1Id, txnId, accUSDId],
          ),
        );

        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('ledger_postings_currency_matches_account');
        expect(err.message ?? '').toContain(
          'ledger posting currency must match its account currency',
        );
      } finally {
        await admin.query('delete from public.transactions where id = $1', [
          txnId,
        ]);
      }
    });

    it('accepts an account leg whose currency matches its account', async () => {
      const txnId = id(7302);
      await admin.query(
        `insert into public.transactions (id, workspace_id, type, account_id, amount_minor, currency, occurred_at, status, created_by)
         values ($1, $2, 'expense', $3, 5000, 'USD', now(), 'confirmed', $4)`,
        [txnId, ws1Id, accUSDId, ownerA],
      );

      try {
        // Insert account leg (USD matching accUSDId) + external counter-leg (USD balancing to zero)
        await admin.query(
          `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', 5000, 'USD', 'confirmed', now()),
                  ($1, $2, null, 'external', -5000, 'USD', 'confirmed', now())`,
          [ws1Id, txnId, accUSDId],
        );

        const countRes = await admin.query<{ count: string }>(
          'select count(*)::text as count from public.ledger_postings where transaction_id = $1',
          [txnId],
        );
        expect(countRes.rows[0].count).toBe('2');
      } finally {
        await admin.query(
          'delete from public.ledger_postings where transaction_id = $1',
          [txnId],
        );
        await admin.query('delete from public.transactions where id = $1', [
          txnId,
        ]);
      }
    });

    it('accepts an external leg (leg_kind = external, account_id is null) regardless of currency', async () => {
      const txnId = id(7303);
      await admin.query(
        `insert into public.transactions (id, workspace_id, type, account_id, amount_minor, currency, occurred_at, status, created_by)
         values ($1, $2, 'expense', $3, 5000, 'USD', now(), 'confirmed', $4)`,
        [txnId, ws1Id, accUSDId, ownerA],
      );

      try {
        // External legs carry no account_id and balance to zero per currency
        await admin.query(
          `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, null, 'external', 5000, 'EUR', 'confirmed', now()),
                  ($1, $2, null, 'external', -5000, 'EUR', 'confirmed', now())`,
          [ws1Id, txnId],
        );

        const countRes = await admin.query<{ count: string }>(
          'select count(*)::text as count from public.ledger_postings where transaction_id = $1',
          [txnId],
        );
        expect(countRes.rows[0].count).toBe('2');
      } finally {
        await admin.query(
          'delete from public.ledger_postings where transaction_id = $1',
          [txnId],
        );
        await admin.query('delete from public.transactions where id = $1', [
          txnId,
        ]);
      }
    });

    it('refuses when account row is not found in the workspace (null account currency raises, not passes)', async () => {
      const txnId = id(7304);
      const nonExistentAccId = id(7999);
      await admin.query(
        `insert into public.transactions (id, workspace_id, type, account_id, amount_minor, currency, occurred_at, status, created_by)
         values ($1, $2, 'expense', $3, 5000, 'USD', now(), 'confirmed', $4)`,
        [txnId, ws1Id, accUSDId, ownerA],
      );

      try {
        // Trigger fires BEFORE foreign key check. Row not found -> v_account_currency is null -> raises
        const err = await capturePgError(() =>
          admin.query(
            `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
             values ($1, $2, $3, 'account', 5000, 'USD', 'confirmed', now())`,
            [ws1Id, txnId, nonExistentAccId],
          ),
        );

        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('ledger_postings_currency_matches_account');
        expect(err.message ?? '').toContain(
          'ledger posting currency must match its account currency',
        );
      } finally {
        await admin.query('delete from public.transactions where id = $1', [
          txnId,
        ]);
      }
    });

    it('accepts a currency-exchange posting set spanning two accounts of different currencies', async () => {
      // Regression test: currency exchanges legitimately write two account legs in two currencies,
      // each matching its own account.
      const txnId = id(7305);
      await admin.query(
        `insert into public.transactions (id, workspace_id, type, account_id, amount_minor, currency, occurred_at, status, created_by)
         values ($1, $2, 'adjustment', $3, 11000, 'USD', now(), 'confirmed', $4)`,
        [txnId, ws1Id, accUSDId, ownerA],
      );

      try {
        // Leg 1: accUSDId (USD) + external counter-leg (USD) -> USD balances to zero
        // Leg 2: accEURId (EUR) + external counter-leg (EUR) -> EUR balances to zero
        await admin.query(
          `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', 11000, 'USD', 'confirmed', now()),
                  ($1, $2, null, 'external', -11000, 'USD', 'confirmed', now()),
                  ($1, $2, $4, 'account', -10000, 'EUR', 'confirmed', now()),
                  ($1, $2, null, 'external', 10000, 'EUR', 'confirmed', now())`,
          [ws1Id, txnId, accUSDId, accEURId],
        );

        const postingsRes = await admin.query<{ count: string }>(
          'select count(*)::text as count from public.ledger_postings where transaction_id = $1',
          [txnId],
        );
        expect(postingsRes.rows[0].count).toBe('4');
      } finally {
        await admin.query(
          'delete from public.ledger_postings where transaction_id = $1',
          [txnId],
        );
        await admin.query('delete from public.transactions where id = $1', [
          txnId,
        ]);
      }
    });
  });

  describe('Migration Upgrade Path (pre-migration validation)', () => {
    const dirtyTxnId = id(7306);

    afterAll(async () => {
      // Ensure trigger and function are restored in case of failure
      const migrationSql = readFileSync(
        resolve(
          process.cwd(),
          'supabase/migrations/202609060002_posting_currency_invariant.sql',
        ),
        'utf-8',
      );
      await admin.query(
        `drop trigger if exists enforce_ledger_posting_currency_matches_account_trigger on public.ledger_postings;
         drop function if exists public.enforce_ledger_posting_currency_matches_account();`,
      );
      await admin
        .query('delete from public.ledger_postings where transaction_id = $1', [
          dirtyTxnId,
        ])
        .catch(() => {});
      await admin
        .query('delete from public.transactions where id = $1', [dirtyTxnId])
        .catch(() => {});
      await admin.query(migrationSql);
    });

    it('refuses to apply migration 202609060002 against dirty pre-migration data and accepts clean data', async () => {
      // 1. Temporarily drop the trigger
      await admin.query(
        `drop trigger if exists enforce_ledger_posting_currency_matches_account_trigger on public.ledger_postings;
         drop function if exists public.enforce_ledger_posting_currency_matches_account();`,
      );

      // 2. Insert a violating row (USD account with EUR posting) with matching counter-leg
      await admin.query(
        `insert into public.transactions (id, workspace_id, type, account_id, amount_minor, currency, occurred_at, status, created_by)
         values ($1, $2, 'expense', $3, 5000, 'EUR', now(), 'confirmed', $4)`,
        [dirtyTxnId, ws1Id, accUSDId, ownerA],
      );
      await admin.query(
        `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, $2, $3, 'account', 5000, 'EUR', 'confirmed', now()),
                ($1, $2, null, 'external', -5000, 'EUR', 'confirmed', now())`,
        [ws1Id, dirtyTxnId, accUSDId],
      );

      const migrationSql = readFileSync(
        resolve(
          process.cwd(),
          'supabase/migrations/202609060002_posting_currency_invariant.sql',
        ),
        'utf-8',
      );

      // 3. Applying migration over dirty data must throw the named diagnostic
      const err = await capturePgError(() => admin.query(migrationSql));
      expect(err.message ?? '').toContain(
        'existing ledger posting currency violates the account currency invariant',
      );

      // Verify trigger was not installed (transaction rolled back)
      const trigCheckDirty = await admin.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgname = 'enforce_ledger_posting_currency_matches_account_trigger'`,
      );
      expect(trigCheckDirty.rows[0].count).toBe('0');

      // 4. Clean path: delete the violating postings
      await admin.query(
        'delete from public.ledger_postings where transaction_id = $1',
        [dirtyTxnId],
      );
      await admin.query('delete from public.transactions where id = $1', [
        dirtyTxnId,
      ]);

      // 5. Applying migration over clean data succeeds
      await expect(admin.query(migrationSql)).resolves.toBeDefined();

      // Verify trigger is now installed
      const trigCheckClean = await admin.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgname = 'enforce_ledger_posting_currency_matches_account_trigger'`,
      );
      expect(trigCheckClean.rows[0].count).toBe('1');
    });
  });

  describe('HTTP Transaction Creation Constraint Translation (422 end-to-end)', () => {
    let httpApp: NestFastifyApplication | undefined;

    beforeAll(async () => {
      Object.assign(process.env, {
        JWT_ISSUER: 'https://issuer.example.test',
        JWT_AUDIENCE: 'savia-api',
        JWT_JWKS_URI: 'https://issuer.example.test/jwks',
        JWT_ALGORITHMS: 'RS256',
      });

      const moduleRef = await Test.createTestingModule({
        imports: [LedgerModule],
      })
        .overrideProvider(JoseJwtVerifier)
        .useValue({
          verify: async (token: string) => {
            if (token === 'owner-token') return { subject: ownerA };
            throw new Error('token rejected');
          },
        })
        .compile();

      httpApp = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ exposeHeadRoutes: false }),
      );
      registerProblemFilter(httpApp);
      await httpApp.init();
      await httpApp.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      if (httpApp) {
        await httpApp.close();
      }
    });

    it('POST /v1/transactions returns 422 with Account currency mismatch problem when transaction currency does not match account currency', async () => {
      if (!httpApp) throw new Error('HTTP app not initialized');

      const response = await httpApp.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': ws1Id,
          'idempotency-key': '00000000-0000-4000-8000-000000000888',
          'content-type': 'application/json',
        },
        payload: {
          type: 'expense',
          accountId: accUSDId, // USD account
          amount: { amountMinor: '5000', currency: 'EUR' }, // Mismatched currency
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      const body = JSON.parse(response.payload);
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.status).toBe(422);
      expect(body.title).toBe('Account currency mismatch');
      expect(body.errors).toEqual([
        {
          field: 'amount.currency',
          code: 'currency-mismatch',
          message: 'Transaction currency must match account currency',
        },
      ]);
    });
  });
});
