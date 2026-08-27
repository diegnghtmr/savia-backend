// Migrations under test: 202608240006_account_currency_invariant.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

type CapturedPgError = { code?: string; message?: string };

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

describe('Account currency workspace invariant, triggers, RLS, and security definer (202608240006_account_currency_invariant.sql)', () => {
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
    it('1. Both triggers exist, fire row-level BEFORE their target events, execute security definer functions owned by savia_elevated with search_path pg_catalog, public', async () => {
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
            and t.tgname = 'enforce_account_currency_matches_workspace_trigger'`,
      );
      expect(accountsTrigRes.rows).toHaveLength(1);
      const accTrig = accountsTrigRes.rows[0];
      expect(accTrig.proname).toBe(
        'enforce_account_currency_matches_workspace',
      );
      expect(accTrig.prosecdef).toBe(true);
      expect(accTrig.proowner).toBe('savia_elevated');
      expect(accTrig.proconfig).toEqual(['search_path=pg_catalog, public']);
      // BEFORE (1) + ROW (2) + INSERT (4) + UPDATE (16) = 23
      expect(accTrig.tgtype & 1).toBe(1); // BEFORE
      expect(accTrig.tgtype & 2).toBe(2); // ROW
      expect(accTrig.tgtype & 4).toBe(4); // INSERT
      expect(accTrig.tgtype & 16).toBe(16); // UPDATE

      const workspacesTrigRes = await admin.query<{
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
          where t.tgrelid = 'public.workspaces'::regclass
            and t.tgname = 'enforce_workspace_base_currency_account_invariant_trigger'`,
      );
      expect(workspacesTrigRes.rows).toHaveLength(1);
      const wsTrig = workspacesTrigRes.rows[0];
      expect(wsTrig.proname).toBe(
        'enforce_workspace_base_currency_account_invariant',
      );
      expect(wsTrig.prosecdef).toBe(true);
      expect(wsTrig.proowner).toBe('savia_elevated');
      expect(wsTrig.proconfig).toEqual(['search_path=pg_catalog, public']);
      // BEFORE (1) + ROW (2) + UPDATE (16) = 19
      expect(wsTrig.tgtype & 1).toBe(1); // BEFORE
      expect(wsTrig.tgtype & 2).toBe(2); // ROW
      expect(wsTrig.tgtype & 16).toBe(16); // UPDATE

      const elevatedPrivRes = await admin.query<{
        can_read_accounts: boolean;
        can_read_workspaces: boolean;
        accounts_policy_rows: number;
        public_exec_acc_fn: boolean;
        public_exec_ws_fn: boolean;
      }>(
        `select has_table_privilege('savia_elevated', 'public.accounts', 'select') as can_read_accounts,
                has_table_privilege('savia_elevated', 'public.workspaces', 'select') as can_read_workspaces,
                (select count(*)::int from pg_policy
                  where polrelid = 'public.accounts'::regclass
                    and polname = 'elevated_reads_accounts') as accounts_policy_rows,
                has_function_privilege('public', 'public.enforce_account_currency_matches_workspace()', 'execute') as public_exec_acc_fn,
                has_function_privilege('public', 'public.enforce_workspace_base_currency_account_invariant()', 'execute') as public_exec_ws_fn`,
      );
      expect(elevatedPrivRes.rows[0].can_read_accounts).toBe(true);
      expect(elevatedPrivRes.rows[0].can_read_workspaces).toBe(true);
      expect(elevatedPrivRes.rows[0].accounts_policy_rows).toBe(1);
      expect(elevatedPrivRes.rows[0].public_exec_acc_fn).toBe(false);
      expect(elevatedPrivRes.rows[0].public_exec_ws_fn).toBe(false);
    });
  });

  describe('Invariant Enforcement (behavioral live proofs)', () => {
    it('a. A direct privileged insert of an account whose currency differs from its workspace base currency raises SQLSTATE 23514 (check_violation)', async () => {
      const err = await capturePgError(() =>
        admin.query(
          `insert into public.accounts (workspace_id, name, type, currency, created_by)
           values ($1, 'Mismatched Currency Account', 'checking', 'EUR', $2)`,
          [ws1Id, ownerA],
        ),
      );
      expect(err.code).toBe('23514');
      expect(err.message ?? '').toContain(
        'account currency must match workspace base currency',
      );
    });

    it('b. A direct privileged insert where account currency matches workspace base currency succeeds', async () => {
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

    it('c. A direct update of public.accounts setting currency to a different value raises SQLSTATE 23514', async () => {
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
        expect(err.message ?? '').toContain(
          'account currency must match workspace base currency',
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

    it('d. A direct update of public.workspaces setting base_currency to a different value while a matching account exists raises SQLSTATE 23514', async () => {
      const inserted = await admin.query<{ id: string }>(
        `insert into public.accounts (workspace_id, name, type, currency, created_by)
         values ($1, 'Active Account In WS1', 'checking', 'USD', $2)
         returning id`,
        [ws1Id, ownerA],
      );
      const accId = inserted.rows[0]?.id;
      expect(accId).toBeDefined();
      try {
        const err = await capturePgError(() =>
          admin.query(
            `update public.workspaces set base_currency = 'EUR' where id = $1`,
            [ws1Id],
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.message ?? '').toContain(
          'workspace base currency cannot change while accounts with differing currencies exist',
        );

        const unchanged = await admin.query<{ base_currency: string }>(
          'select base_currency from public.workspaces where id = $1',
          [ws1Id],
        );
        expect(unchanged.rows[0].base_currency).toBe('USD');
      } finally {
        if (accId) await deleteAccount(accId);
      }
    });

    it('e. Updating public.workspaces base_currency succeeds when the workspace has NO accounts (deliberately permitted, trigger does not over-refuse)', async () => {
      const before = await admin.query<{ base_currency: string }>(
        'select base_currency from public.workspaces where id = $1',
        [emptyWsId],
      );
      expect(before.rows[0].base_currency).toBe('USD');

      const updateRes = await admin.query(
        `update public.workspaces set base_currency = 'EUR' where id = $1`,
        [emptyWsId],
      );
      expect(updateRes.rowCount).toBe(1);

      const after = await admin.query<{ base_currency: string }>(
        'select base_currency from public.workspaces where id = $1',
        [emptyWsId],
      );
      expect(after.rows[0].base_currency).toBe('EUR');

      // Reset back to USD for hygiene
      await admin.query(
        `update public.workspaces set base_currency = 'USD' where id = $1`,
        [emptyWsId],
      );
    });

    it('f. SECURITY DEFINER DEFENSE IN DEPTH: an outsider attempting a mismatched insert fails with 23514 from the trigger rather than 42501 from RLS, detecting definer-to-invoker regression', async () => {
      // ownerA has NO membership in wsOtherId (wsOtherId base_currency is USD).
      // Under savia_application with app.subject_id = ownerA, RLS policy application_reads_member_workspace
      // returns zero rows for wsOtherId.
      // With SECURITY INVOKER:
      //   - The trigger lookup `select base_currency from public.workspaces` would return NULL due to RLS filtering.
      //   - The trigger would not detect the currency mismatch and execution would continue until table RLS fails with 42501.
      // With SECURITY DEFINER owned by savia_elevated:
      //   - The trigger reads base_currency ('USD') via elevated_reads_workspaces.
      //   - It detects the mismatch ('EUR' <> 'USD') and raises 23514 (check_violation) before RLS.
      // This test verifies that security definer is active and prevents regression to security invoker.
      const blindErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.accounts (workspace_id, name, type, currency, created_by)
             values ($1, 'Cross-Workspace Mismatched Account', 'cash', 'EUR', $2)`,
            [wsOtherId, ownerA],
          ),
        ),
      );

      // Must be 23514 (check_violation from our trigger), NOT 42501 (RLS policy violation).
      expect(blindErr.code).toBe('23514');
      expect(blindErr.message ?? '').toContain(
        'account currency must match workspace base currency',
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

    it('g. CONCURRENCY / WRITE SKEW SERIALIZATION: two concurrent transactions serialize via advisory lock; loser re-observes committed state and raises 23514', async () => {
      // Starting condition: emptyWsId with base_currency = 'USD' and no accounts.
      // Forced ordering:
      // 1. Client 1 begins transaction and inserts a USD account. Trigger acquires workspace advisory lock.
      // 2. Client 2 begins transaction and attempts to update workspace base_currency to 'EUR'.
      //    Client 2's trigger blocks on the workspace advisory lock held by Client 1.
      // 3. We prove Client 2 is blocked while Client 1 holds the lock.
      // 4. Client 1 commits, persisting the USD account and releasing the advisory lock.
      // 5. Client 2 unblocks, acquires advisory lock, scans accounts under READ COMMITTED,
      //    sees Client 1's newly committed USD account, and raises 23514 (check_violation).
      const client1 = await admin.connect();
      const client2 = await admin.connect();
      let createdAccountId: string | undefined;

      try {
        await client1.query('begin');
        const insertRes = await client1.query<{ id: string }>(
          `insert into public.accounts (workspace_id, name, type, currency, created_by)
           values ($1, 'Concurrent Account', 'checking', 'USD', $2)
           returning id`,
          [emptyWsId, ownerA],
        );
        createdAccountId = insertRes.rows[0]?.id;

        await client2.query('begin');

        let client2Resolved = false;
        let client2Error: CapturedPgError | undefined;

        const client2Promise = client2
          .query(
            `update public.workspaces set base_currency = 'EUR' where id = $1`,
            [emptyWsId],
          )
          .then(() => {
            client2Resolved = true;
          })
          .catch((err: unknown) => {
            client2Error = err as CapturedPgError;
          });

        // Give Client 2 time to execute and block on Client 1's advisory lock
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(client2Resolved).toBe(false);
        expect(client2Error).toBeUndefined();

        // Client 1 commits: releases lock and makes inserted USD account visible under READ COMMITTED
        await client1.query('commit');

        // Client 2 should now unblock, acquire lock, scan accounts, see the USD account, and reject
        await client2Promise;
        expect(client2Resolved).toBe(false);
        expect(client2Error).toBeDefined();
        expect(client2Error?.code).toBe('23514');
        expect(client2Error?.message ?? '').toContain(
          'workspace base currency cannot change while accounts with differing currencies exist',
        );

        await client2.query('rollback').catch(() => {});

        // Confirm workspace base_currency remains USD
        const wsRes = await admin.query<{ base_currency: string }>(
          'select base_currency from public.workspaces where id = $1',
          [emptyWsId],
        );
        expect(wsRes.rows[0].base_currency).toBe('USD');
      } finally {
        if (createdAccountId) {
          await deleteAccount(createdAccountId);
        }
        client1.release();
        client2.release();
      }
    });
  });
});
