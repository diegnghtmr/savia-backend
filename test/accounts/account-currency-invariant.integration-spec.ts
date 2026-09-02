// Migrations under test: 202608240006_account_currency_invariant.sql, 202608290001_relax_account_currency_invariant.sql, 202609020003_budget_currency_invariant.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

type CapturedPgError = {
  code?: string;
  message?: string;
  constraint?: string;
};

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

describe('Account currency workspace invariant, triggers, RLS, and security definer (202608290001_relax_account_currency_invariant.sql)', () => {
  let admin: Pool;

  const ownerA = subject(601);
  const adminC = subject(602);
  const editorD = subject(603);
  const viewerE = subject(604);
  const outsiderZ = subject(605);
  const ownerB = subject(606);

  const ws1Id = '00000000-0000-0000-0000-000000000651';
  const ws2Id = '00000000-0000-0000-0000-000000000652';
  const emptyWsId = '00000000-0000-0000-0000-000000000653';
  const wsOtherId = '00000000-0000-0000-0000-000000000654';

  const memOwnerAId = '00000000-0000-0000-0000-000000000611';
  const memAdminCId = '00000000-0000-0000-0000-000000000612';
  const memEditorDId = '00000000-0000-0000-0000-000000000613';
  const memViewerEId = '00000000-0000-0000-0000-000000000614';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000000615';
  const memEmptyWsOwnerAId = '00000000-0000-0000-0000-000000000616';
  const memWsOtherOwnerBId = '00000000-0000-0000-0000-000000000617';

  async function asSubject<T>(
    subjectId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subjectId,
      ]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function deleteAccount(id: string): Promise<void> {
    await admin.query('delete from public.accounts where id = $1', [id]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        ownerA,
        'invariant-owner-a@example.test',
        adminC,
        'invariant-admin-c@example.test',
        editorD,
        'invariant-editor-d@example.test',
        viewerE,
        'invariant-viewer-e@example.test',
        outsiderZ,
        'invariant-outsider-z@example.test',
        ownerB,
        'invariant-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'invariant-owner-a@example.test', 'Invariant Owner A'],
      [adminC, 'invariant-admin-c@example.test', 'Invariant Admin C'],
      [editorD, 'invariant-editor-d@example.test', 'Invariant Editor D'],
      [viewerE, 'invariant-viewer-e@example.test', 'Invariant Viewer E'],
      [outsiderZ, 'invariant-outsider-z@example.test', 'Invariant Outsider Z'],
      [ownerB, 'invariant-owner-b@example.test', 'Invariant Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Invariant Shared WS 1', 'shared', 'USD', null, $2),
              ($3, 'Invariant Shared WS 2', 'shared', 'EUR', null, $4),
              ($5, 'Invariant Empty WS', 'shared', 'USD', null, $2),
              ($6, 'Invariant Other WS', 'shared', 'USD', null, $4)`,
      [ws1Id, ownerA, ws2Id, ownerB, emptyWsId, wsOtherId],
    );

    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'administrator', 'active'),
              ($7, $8, $9, 'editor', 'active'),
              ($10, $11, $12, 'viewer', 'active'),
              ($13, $14, $15, 'owner', 'active'),
              ($16, $17, $18, 'owner', 'active'),
              ($19, $20, $21, 'owner', 'active')`,
      [
        memOwnerAId,
        ws1Id,
        ownerA,
        memAdminCId,
        ws1Id,
        adminC,
        memEditorDId,
        ws1Id,
        editorD,
        memViewerEId,
        ws1Id,
        viewerE,
        memWs2OwnerBId,
        ws2Id,
        ownerB,
        memEmptyWsOwnerAId,
        emptyWsId,
        ownerA,
        memWsOtherOwnerBId,
        wsOtherId,
        ownerB,
      ],
    );

    // Seed an exchange rate in ws1Id (base_currency: USD) for GBP -> USD
    await admin.query(
      `insert into public.exchange_rates (workspace_id, base_currency, quote_currency, rate, effective_at, source, created_by)
       values ($1, 'GBP', 'USD', 1.3000, '2026-07-01T00:00:00.000Z', 'manual', $2)`,
      [ws1Id, ownerA],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.accounts where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id, emptyWsId, wsOtherId]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.workspaces where id = any($1::uuid[])', [
          [ws1Id, ws2Id, emptyWsId, wsOtherId],
        ])
        .catch(() => {});
      await admin
        .query('delete from public.profiles where id = any($1::uuid[])', [
          [ownerA, adminC, editorD, viewerE, outsiderZ, ownerB],
        ])
        .catch(() => {});
      await admin
        .query('delete from auth.users where id = any($1::uuid[])', [
          [ownerA, adminC, editorD, viewerE, outsiderZ, ownerB],
        ])
        .catch(() => {});
      await admin.end();
    }
  });

  describe('Structure and Catalog metadata', () => {
    it('enforce_budget_currency_has_exchange_rates_trigger exists on public.budgets with full catalog definition', async () => {
      const budgetTrigRes = await admin.query<{
        tgname: string;
        tgtype: number;
        proname: string;
        prosecdef: boolean;
        proowner: string;
        proconfig: string[] | null;
      }>(
        `select t.tgname,
                t.tgtype,
                p.proname::text as proname,
                p.prosecdef,
                p.proowner::regrole::text as proowner,
                p.proconfig
           from pg_trigger t
           join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = 'public.budgets'::regclass
            and t.tgname = 'enforce_budget_currency_has_exchange_rates_trigger'`,
      );
      expect(budgetTrigRes.rows).toHaveLength(1);
      const bTrig = budgetTrigRes.rows[0];
      expect(bTrig.proname).toBe(
        'enforce_budget_currency_has_exchange_rates',
      );
      expect(bTrig.prosecdef).toBe(true);
      expect(bTrig.proowner).toBe('savia_elevated');
      expect(bTrig.proconfig).toEqual(['search_path=pg_catalog, public']);
      // BEFORE (1) + ROW (2) + INSERT (4) + UPDATE (16) = 23
      expect(bTrig.tgtype & 1).toBe(1); // BEFORE
      expect(bTrig.tgtype & 2).toBe(2); // ROW
      expect(bTrig.tgtype & 4).toBe(4); // INSERT
      expect(bTrig.tgtype & 16).toBe(16); // UPDATE

      const budgetColsRes = await admin.query<{ col_name: string }>(
        `select a.attname::text as col_name
           from pg_trigger t
           join pg_attribute a
             on a.attrelid = t.tgrelid
            and a.attnum = any(string_to_array(t.tgattr::text, ' ')::int2[])
          where t.tgrelid = 'public.budgets'::regclass
            and t.tgname = 'enforce_budget_currency_has_exchange_rates_trigger'
          order by a.attname`,
      );
      expect(budgetColsRes.rows.map((r) => r.col_name)).toEqual([
        'currency',
        'workspace_id',
      ]);

      const privRes = await admin.query<{ public_exec_fn: boolean }>(
        `select has_function_privilege('public', 'public.enforce_budget_currency_has_exchange_rates()', 'execute') as public_exec_fn`,
      );
      expect(privRes.rows[0].public_exec_fn).toBe(false);
    });

    it('enforce_account_currency_has_budget_rates_trigger exists on public.accounts with full catalog definition', async () => {
      const accBudgetTrigRes = await admin.query<{
        tgname: string;
        tgtype: number;
        proname: string;
        prosecdef: boolean;
        proowner: string;
        proconfig: string[] | null;
      }>(
        `select t.tgname,
                t.tgtype,
                p.proname::text as proname,
                p.prosecdef,
                p.proowner::regrole::text as proowner,
                p.proconfig
           from pg_trigger t
           join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = 'public.accounts'::regclass
            and t.tgname = 'enforce_account_currency_has_budget_rates_trigger'`,
      );
      expect(accBudgetTrigRes.rows).toHaveLength(1);
      const abTrig = accBudgetTrigRes.rows[0];
      expect(abTrig.proname).toBe(
        'enforce_account_currency_has_budget_rates',
      );
      expect(abTrig.prosecdef).toBe(true);
      expect(abTrig.proowner).toBe('savia_elevated');
      expect(abTrig.proconfig).toEqual(['search_path=pg_catalog, public']);
      // BEFORE (1) + ROW (2) + INSERT (4) + UPDATE (16) = 23
      expect(abTrig.tgtype & 1).toBe(1); // BEFORE
      expect(abTrig.tgtype & 2).toBe(2); // ROW
      expect(abTrig.tgtype & 4).toBe(4); // INSERT
      expect(abTrig.tgtype & 16).toBe(16); // UPDATE

      const accBudgetColsRes = await admin.query<{ col_name: string }>(
        `select a.attname::text as col_name
           from pg_trigger t
           join pg_attribute a
             on a.attrelid = t.tgrelid
            and a.attnum = any(string_to_array(t.tgattr::text, ' ')::int2[])
          where t.tgrelid = 'public.accounts'::regclass
            and t.tgname = 'enforce_account_currency_has_budget_rates_trigger'
          order by a.attname`,
      );
      expect(accBudgetColsRes.rows.map((r) => r.col_name)).toEqual([
        'currency',
        'workspace_id',
      ]);

      const privRes = await admin.query<{ public_exec_fn: boolean }>(
        `select has_function_privilege('public', 'public.enforce_account_currency_has_budget_rates()', 'execute') as public_exec_fn`,
      );
      expect(privRes.rows[0].public_exec_fn).toBe(false);
    });
    it('1. Trigger exists on public.accounts, fires row-level BEFORE insert or update, executes security definer function owned by savia_elevated with search_path pg_catalog, public', async () => {
      const accountsTrigRes = await admin.query<{
        tgname: string;
        tgtype: number;
        proname: string;
        prosecdef: boolean;
        proowner: string;
        proconfig: string[] | null;
      }>(
        `select t.tgname,
                t.tgtype,
                p.proname::text as proname,
                p.prosecdef,
                p.proowner::regrole::text as proowner,
                p.proconfig
           from pg_trigger t
           join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = 'public.accounts'::regclass
            and t.tgname = 'enforce_account_currency_has_exchange_rate_trigger'`,
      );
      expect(accountsTrigRes.rows).toHaveLength(1);
      const accTrig = accountsTrigRes.rows[0];
      expect(accTrig.proname).toBe(
        'enforce_account_currency_has_exchange_rate',
      );
      expect(accTrig.prosecdef).toBe(true);
      expect(accTrig.proowner).toBe('savia_elevated');
      expect(accTrig.proconfig).toEqual(['search_path=pg_catalog, public']);
      // BEFORE (1) + ROW (2) + INSERT (4) + UPDATE (16) = 23
      expect(accTrig.tgtype & 1).toBe(1); // BEFORE
      expect(accTrig.tgtype & 2).toBe(2); // ROW
      expect(accTrig.tgtype & 4).toBe(4); // INSERT
      expect(accTrig.tgtype & 16).toBe(16); // UPDATE

      const elevatedPrivRes = await admin.query<{
        can_read_accounts: boolean;
        can_read_workspaces: boolean;
        can_read_exchange_rates: boolean;
        exchange_rates_policy_rows: number;
        public_exec_acc_fn: boolean;
      }>(
        `select has_table_privilege('savia_elevated', 'public.accounts', 'select') as can_read_accounts,
                has_table_privilege('savia_elevated', 'public.workspaces', 'select') as can_read_workspaces,
                has_table_privilege('savia_elevated', 'public.exchange_rates', 'select') as can_read_exchange_rates,
                (select count(*)::int from pg_policy
                  where polrelid = 'public.exchange_rates'::regclass
                    and polname = 'elevated_reads_exchange_rates') as exchange_rates_policy_rows,
                has_function_privilege('public', 'public.enforce_account_currency_has_exchange_rate()', 'execute') as public_exec_acc_fn`,
      );
      expect(elevatedPrivRes.rows[0].can_read_accounts).toBe(true);
      expect(elevatedPrivRes.rows[0].can_read_workspaces).toBe(true);
      expect(elevatedPrivRes.rows[0].can_read_exchange_rates).toBe(true);
      expect(elevatedPrivRes.rows[0].exchange_rates_policy_rows).toBe(1);
      expect(elevatedPrivRes.rows[0].public_exec_acc_fn).toBe(false);
    });

    it('2. The accounts trigger pins its specific UPDATE OF column list in pg_trigger.tgattr', async () => {
      const accountsColsRes = await admin.query<{ col_name: string }>(
        `select a.attname::text as col_name
           from pg_trigger t
           join pg_attribute a
             on a.attrelid = t.tgrelid
            and a.attnum = any(string_to_array(t.tgattr::text, ' ')::int2[])
          where t.tgrelid = 'public.accounts'::regclass
            and t.tgname = 'enforce_account_currency_has_exchange_rate_trigger'
          order by a.attname`,
      );
      const accountsCols = accountsColsRes.rows.map((r) => r.col_name);
      expect(accountsCols).toEqual(['currency', 'workspace_id']);
    });
  });

  describe('Invariant Enforcement (behavioral live proofs)', () => {
    it('budget creation refuses when an existing account lacks a rate to the frozen budget currency', async () => {
      const budgetId = subject(699);
      const accountId = subject(698);
      await admin.query(
        `insert into public.accounts (id,workspace_id,name,type,currency,created_by) values ($1,$2,'GBP Budget Account','cash','GBP',$3)`,
        [accountId, ws1Id, ownerA],
      );
      const err = await capturePgError(() =>
        admin.query(
          `insert into public.budgets (id,workspace_id,name,method,period_start,period_end,currency,created_by) values ($1,$2,'Unrated Budget','envelope','2026-01-01','2026-02-01','EUR',$3)`,
          [budgetId, ws1Id, ownerA],
        ),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe(
        'budgets_currency_requires_account_exchange_rates',
      );
      expect(err.message ?? '').toContain(
        'budget currency requires exchange rates for all account currencies',
      );
      await admin.query('delete from public.accounts where id=$1', [accountId]);
    });

    it('account introduction refuses when an existing frozen budget lacks a rate to its currency', async () => {
      const budgetId = subject(697);
      const accountId = subject(696);
      await admin.query(
        `insert into public.exchange_rates (workspace_id,base_currency,quote_currency,rate,effective_at,source,created_by) values ($1,'EUR','USD',1.1,'2026-01-01','test',$2)`,
        [emptyWsId, ownerA],
      );
      await admin.query(
        `insert into public.budgets (id,workspace_id,name,method,period_start,period_end,currency,created_by) values ($1,$2,'COP Budget','envelope','2026-01-01','2026-02-01','COP',$3)`,
        [budgetId, emptyWsId, ownerA],
      );
      try {
        const err = await capturePgError(() =>
          admin.query(
            `insert into public.accounts (id,workspace_id,name,type,currency,created_by) values ($1,$2,'EUR Account','cash','EUR',$3)`,
            [accountId, emptyWsId, ownerA],
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe(
          'accounts_currency_requires_budget_exchange_rates',
        );
        expect(err.message ?? '').toContain(
          'account currency requires exchange rates for all budget currencies',
        );
      } finally {
        await admin.query('delete from public.budgets where id=$1', [budgetId]);
      }
    });
    it('a. A direct privileged insert of an account whose currency differs from workspace base currency with NO exchange rate raises SQLSTATE 23514 (check_violation)', async () => {
      const err = await capturePgError(() =>
        admin.query(
          `insert into public.accounts (workspace_id, name, type, currency, created_by)
           values ($1, 'Mismatched Currency Account', 'checking', 'EUR', $2)`,
          [ws1Id, ownerA],
        ),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('accounts_currency_requires_exchange_rate');
      expect(err.message ?? '').toContain(
        'exchange rate required for account currency differing from workspace base currency',
      );
    });

    it('b. A direct privileged insert where account currency matches workspace base currency succeeds without exchange rate', async () => {
      const inserted = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'Matching Currency Account', 'checking', 'USD', $2)
         returning id`,
        [ws1Id, ownerA],
      );
      const accId = inserted.rows[0]?.id;
      expect(accId).toBeDefined();
      try {
        const stored = await admin.query<{ count: number }>(
          'select count(*)::int as count from public.accounts where id = $1',
          [accId],
        );
        expect(stored.rows[0].count).toBe(1);
      } finally {
        if (accId) await deleteAccount(accId);
      }
    });

    it('c. A direct privileged insert where account currency differs from workspace base currency SUCCEEDS when an exchange rate exists', async () => {
      const inserted = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'GBP Account With Rate', 'checking', 'GBP', $2)
         returning id`,
        [ws1Id, ownerA],
      );
      const accId = inserted.rows[0]?.id;
      expect(accId).toBeDefined();
      try {
        const stored = await admin.query<{ count: number; currency: string }>(
          'select count(*)::int as count, currency from public.accounts where id = $1 group by currency',
          [accId],
        );
        expect(stored.rows[0].count).toBe(1);
        expect(stored.rows[0].currency).toBe('GBP');
      } finally {
        if (accId) await deleteAccount(accId);
      }
    });

    it('c2. Changing workspace base_currency is REFUSED when it would strand an account with no rate against the new base', async () => {
      // The account-side trigger cannot see this: it fires on accounts, not on
      // workspaces. Without the workspace-side trigger, a base currency change would
      // silently leave existing accounts unconvertible and make getAccountBalance
      // throw for accounts that were perfectly valid when created.
      const originalRes = await admin.query<{ base_currency: string }>(
        'select base_currency from public.workspaces where id = $1',
        [ws1Id],
      );
      const originalBase = originalRes.rows[0].base_currency.trim();

      const inserted = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'Account Stranded By Base Change', 'checking', 'GBP', $2)
         returning id`,
        [ws1Id, ownerA],
      );
      const accId = inserted.rows[0]?.id;
      try {
        const err = await capturePgError(() =>
          admin.query(
            `update public.workspaces set base_currency = 'JPY' where id = $1`,
            [ws1Id],
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe(
          'workspace_base_currency_keeps_accounts_convertible',
        );
        expect(err.message ?? '').toContain(
          'workspace base currency cannot change while accounts would be left without an exchange rate',
        );

        const unchanged = await admin.query<{ base_currency: string }>(
          'select base_currency from public.workspaces where id = $1',
          [ws1Id],
        );
        expect(unchanged.rows[0].base_currency.trim()).not.toBe('JPY');
      } finally {
        // Restore defensively. If the guard under test is ever missing, the update
        // above SUCCEEDS and would leave this shared workspace on JPY, making every
        // later test in this file fail for a reason that has nothing to do with them.
        await admin.query(
          'update public.workspaces set base_currency = $2 where id = $1',
          [ws1Id, originalBase],
        );
        if (accId) await deleteAccount(accId);
      }
    });

    it('c3. Changing workspace base_currency is ALLOWED when every account stays convertible', async () => {
      // Prove the other half. A rule that refused every base currency change would
      // also pass the test above while being far stricter than intended.
      const before = await admin.query<{ base_currency: string }>(
        'select base_currency from public.workspaces where id = $1',
        [emptyWsId],
      );
      const original = before.rows[0].base_currency.trim();

      await admin.query(
        `update public.workspaces set base_currency = 'JPY' where id = $1`,
        [emptyWsId],
      );
      const after = await admin.query<{ base_currency: string }>(
        'select base_currency from public.workspaces where id = $1',
        [emptyWsId],
      );
      expect(after.rows[0].base_currency.trim()).toBe('JPY');

      await admin.query(
        `update public.workspaces set base_currency = $2 where id = $1`,
        [emptyWsId, original],
      );
    });

    it('d. A direct update of public.accounts setting currency to a value with no exchange rate raises SQLSTATE 23514', async () => {
      const inserted = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'Account To Mutate Currency', 'checking', 'USD', $2)
         returning id`,
        [ws1Id, ownerA],
      );
      const accId = inserted.rows[0]?.id;
      expect(accId).toBeDefined();
      try {
        const err = await capturePgError(() =>
          admin.query(
            `update public.accounts set currency = 'EUR' where id = $1`,
            [accId],
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('accounts_currency_requires_exchange_rate');
        expect(err.message ?? '').toContain(
          'exchange rate required for account currency differing from workspace base currency',
        );

        const unchanged = await admin.query<{ currency: string }>(
          'select currency from public.accounts where id = $1',
          [accId],
        );
        expect(unchanged.rows[0].currency).toBe('USD');
      } finally {
        if (accId) await deleteAccount(accId);
      }
    });

    it('e. SECURITY DEFINER DEFENSE IN DEPTH: an outsider attempting an unrated insert fails with 23514 from the trigger rather than 42501 from RLS', async () => {
      // ownerA has NO membership in wsOtherId (wsOtherId base_currency is USD).
      // Under savia_application with app.subject_id = ownerA, RLS policy application_reads_member_workspace
      // returns zero rows for wsOtherId.
      // With SECURITY DEFINER owned by savia_elevated:
      //   - The trigger reads base_currency ('USD') and exchange_rates via elevated policies.
      //   - It detects the missing rate ('EUR' -> 'USD') and raises 23514 before table RLS fails with 42501.
      const blindErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.accounts (workspace_id, name, type, currency, created_by)
             values ($1, 'Cross-Workspace Unrated Account', 'cash', 'EUR', $2)`,
            [wsOtherId, ownerA],
          ),
        ),
      );

      expect(blindErr.code).toBe('23514');
      expect(blindErr.constraint).toBe('accounts_currency_requires_exchange_rate');
      expect(blindErr.message ?? '').toContain(
        'exchange rate required for account currency differing from workspace base currency',
      );
      expect(blindErr.message ?? '').not.toContain('row-level security');
      expect(blindErr.message ?? '').not.toContain('permission denied');

      // Positive control: an authorized insert by an owner with matching currency succeeds through savia_application.
      const okIds = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `insert into public.accounts (workspace_id, name, type, currency, created_by)
           values ($1, 'Authorized Matching Account', 'cash', 'USD', $2)
           returning id`,
          [ws1Id, ownerA],
        );
        return res.rows.map((r) => r.id);
      });
      expect(okIds).toHaveLength(1);
      try {
        const stored = await admin.query<{ count: number }>(
          'select count(*)::int as count from public.accounts where id = $1',
          [okIds[0]],
        );
        expect(stored.rows[0].count).toBe(1);
      } finally {
        await deleteAccount(okIds[0]);
      }
    });

    it('f. A direct update of public.accounts moving workspace_id to a workspace with no exchange rate for account currency raises SQLSTATE 23514', async () => {
      // GBP account in ws1Id (which has GBP->USD rate). ws2Id base_currency is EUR and has no GBP->EUR rate.
      const inserted = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'Account To Move Across Workspaces', 'checking', 'GBP', $2)
         returning id`,
        [ws1Id, ownerA],
      );
      const accId = inserted.rows[0]?.id;
      expect(accId).toBeDefined();
      try {
        const err = await capturePgError(() =>
          admin.query(
            `update public.accounts set workspace_id = $1 where id = $2`,
            [ws2Id, accId],
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('accounts_currency_requires_exchange_rate');
        expect(err.message ?? '').toContain(
          'exchange rate required for account currency differing from workspace base currency',
        );

        const unchanged = await admin.query<{ workspace_id: string }>(
          'select workspace_id::text from public.accounts where id = $1',
          [accId],
        );
        expect(unchanged.rows[0].workspace_id).toBe(ws1Id);
      } finally {
        if (accId) await deleteAccount(accId);
      }
    });
  });
});
