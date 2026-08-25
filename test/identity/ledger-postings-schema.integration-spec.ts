// Migrations under test: 202608240005_ledger_postings.sql
import { randomUUID } from 'node:crypto';
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

describe('Ledger postings schema, balanced-postings invariant, RLS, and grants (202608240005_ledger_postings.sql)', () => {
  let admin: Pool;

  const ownerA = subject(701);
  const adminC = subject(702);
  const editorD = subject(703);
  const viewerE = subject(704);
  const outsiderZ = subject(705);
  const ownerB = subject(706);

  const ws1Id = '00000000-0000-0000-0000-000000000751';
  const ws2Id = '00000000-0000-0000-0000-000000000752';
  const dosWsId = '00000000-0000-0000-0000-000000000753';

  const memOwnerAId = '00000000-0000-0000-0000-000000000711';
  const memAdminCId = '00000000-0000-0000-0000-000000000712';
  const memEditorDId = '00000000-0000-0000-0000-000000000713';
  const memViewerEId = '00000000-0000-0000-0000-000000000714';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000000715';

  const account1Id = '00000000-0000-0000-0000-000000000771';
  const account2Id = '00000000-0000-0000-0000-000000000772';

  const transaction1Id = '00000000-0000-0000-0000-000000000781';
  const transaction2Id = '00000000-0000-0000-0000-000000000782';

  type PostingSeed = {
    workspaceId: string;
    transactionId?: string | null;
    transferId?: string | null;
    accountId?: string | null;
    legKind: string;
    amountMinor: string;
    currency?: string;
    status?: string;
  };

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

  // Superuser path: bypasses RLS and every grant so that ONLY the named
  // mechanism under test (a CHECK, a foreign key, or the balance trigger) can
  // refuse. Approved isolation technique from the slice 3 suites.
  //
  // USE ONLY FOR STATEMENT-TIME REFUSAL PROBES. A lone leg can never COMMIT:
  // the deferred balance trigger refuses any group with fewer than two legs,
  // so every SUCCESS-path fixture must go through seedBalancedPair below.
  async function seedPosting(posting: PostingSeed): Promise<string> {
    const res = await admin.query<{ id: string }>(
      `insert into public.ledger_postings
         (workspace_id, transaction_id, transfer_id, account_id, leg_kind,
          amount_minor, currency, status, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, '2026-08-24T12:00:00Z')
       returning id`,
      [
        posting.workspaceId,
        posting.transactionId ?? null,
        posting.transferId ?? null,
        posting.accountId ?? null,
        posting.legKind,
        posting.amountMinor,
        posting.currency ?? 'USD',
        posting.status ?? 'confirmed',
      ],
    );
    return res.rows[0].id;
  }

  // One statement, one complete set: an account debit (+amount) and its
  // external credit (-amount). Both ids are returned so cleanup always removes
  // WHOLE groups — deleting half a group would trip the balance trigger at the
  // cleanup statement's own commit.
  async function seedBalancedPair(options: {
    workspaceId: string;
    transactionId: string;
    accountId: string;
    amountMinor?: string;
    accountStatus?: string;
  }): Promise<string[]> {
    const res = await admin.query<{ id: string }>(
      `insert into public.ledger_postings
         (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
       values ($1, $2, $3, 'account', $4, 'USD', $5, '2026-08-24T12:00:00Z'),
              ($1, $2, null, 'external', -$4, 'USD', 'confirmed', '2026-08-24T12:00:00Z')
       returning id`,
      [
        options.workspaceId,
        options.transactionId,
        options.accountId,
        options.amountMinor ?? '100',
        options.accountStatus ?? 'confirmed',
      ],
    );
    return res.rows.map((r) => r.id);
  }

  async function deletePostings(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    // Whole groups in ONE statement: the deferred balance trigger fires at the
    // statement's commit, so removing a partial group here would trip it.
    await admin.query(
      'delete from public.ledger_postings where id = any($1::uuid[])',
      [ids],
    );
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        ownerA,
        'ledger-owner-a@example.test',
        adminC,
        'ledger-admin-c@example.test',
        editorD,
        'ledger-editor-d@example.test',
        viewerE,
        'ledger-viewer-e@example.test',
        outsiderZ,
        'ledger-outsider-z@example.test',
        ownerB,
        'ledger-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'ledger-owner-a@example.test', 'Ledger Owner A'],
      [adminC, 'ledger-admin-c@example.test', 'Ledger Admin C'],
      [editorD, 'ledger-editor-d@example.test', 'Ledger Editor D'],
      [viewerE, 'ledger-viewer-e@example.test', 'Ledger Viewer E'],
      [outsiderZ, 'ledger-outsider-z@example.test', 'Ledger Outsider Z'],
      [ownerB, 'ledger-owner-b@example.test', 'Ledger Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Ledger Shared Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Ledger Shared Workspace 2', 'shared', 'USD', null, $4)`,
      [ws1Id, ownerA, ws2Id, ownerB],
    );

    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'administrator', 'active'),
              ($7, $8, $9, 'editor', 'active'),
              ($10, $11, $12, 'viewer', 'active'),
              ($13, $14, $15, 'owner', 'active')`,
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
      ],
    );

    // Postings take composite foreign keys to BOTH siblings, so the RLS tests
    // need one live account and one live transaction per workspace.
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
       values ($1, $2, 'Ledger Test Account 1', 'cash', 'USD', $3),
              ($4, $5, 'Ledger Test Account 2', 'cash', 'USD', $6)`,
      [account1Id, ws1Id, ownerA, account2Id, ws2Id, ownerB],
    );
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
       values ($1, $2, $3, 'income', 'confirmed', '12345', 'USD', '2026-08-24T12:00:00Z', $4),
              ($5, $6, $7, 'expense', 'confirmed', '6789', 'USD', '2026-08-24T12:00:00Z', $8)`,
      [
        transaction1Id,
        ws1Id,
        account1Id,
        ownerA,
        transaction2Id,
        ws2Id,
        account2Id,
        ownerB,
      ],
    );
  });

  afterAll(async () => {
    // Defensive sweep: postings die first (they carry restrict references),
    // then the workspace cascade removes the rest. Leftover UNBALANCED legs
    // would poison every later commit through the global balance trigger.
    if (admin) {
      await admin
        .query(
          'delete from public.ledger_postings where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id, dosWsId]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.workspaces where id = any($1::uuid[])', [
          [ws1Id, ws2Id, dosWsId],
        ])
        .catch(() => {});
      await admin.end();
    }
  });

  describe('Structure and ACL', () => {
    it('1. The fitness:financial tag is present and apostrophe-free on public.ledger_postings', async () => {
      const res = await admin.query<{ description: string | null }>(
        `select obj_description('public.ledger_postings'::regclass) as description`,
      );

      const description = res.rows[0].description;
      expect(description).not.toBeNull();
      expect(description).toContain('fitness:financial');
      // An apostrophe inside the comment text makes
      // scripts/verify-financial-tables.mjs stop matching the tag, so the
      // table silently escapes the workspace_id rule. Pin the text itself.
      expect(description).not.toContain("'");
    });

    it('2. public.ledger_postings has relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
          from pg_class
          where oid = 'public.ledger_postings'::regclass`,
      );
      expect(rlsRes.rows[0].relrowsecurity).toBe(true);
      expect(rlsRes.rows[0].relforcerowsecurity).toBe(true);
    });

    it('3. savia_application holds SELECT on every column, INSERT on exactly (account_id, amount_minor, currency, leg_kind, occurred_at, status, transaction_id, transfer_id, workspace_id), UPDATE on exactly (status)', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.ledger_postings', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.ledger_postings', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.ledger_postings', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'ledger_postings'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'account_id',
        'amount_minor',
        'created_at',
        'currency',
        'id',
        'leg_kind',
        'occurred_at',
        'status',
        'transaction_id',
        'transfer_id',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'account_id',
        'amount_minor',
        'currency',
        'leg_kind',
        'occurred_at',
        'status',
        'transaction_id',
        'transfer_id',
        'workspace_id',
      ]);

      // status is the ONLY mutable column, and that is enforced by the GRANT,
      // not by convention: amount, account, currency and identity are
      // immutable by grant (idiom: 202607150014:60).
      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual(['status']);
    });

    it('4. The complete column inventory is pinned — ANY added column fails this test', async () => {
      const inventoryRes = await admin.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'ledger_postings'
          order by column_name`,
      );
      expect(inventoryRes.rows.map((r) => r.column_name)).toEqual([
        'account_id',
        'amount_minor',
        'created_at',
        'currency',
        'id',
        'leg_kind',
        'occurred_at',
        'status',
        'transaction_id',
        'transfer_id',
        'workspace_id',
      ]);
    });

    it('5. savia_application holds NO delete privilege and there is NO delete policy (the ledger is append-only, RULING 29); the full policy inventory is pinned', async () => {
      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.ledger_postings', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);

      const policiesRes = await admin.query<{
        polname: string;
        polcmd: string;
        grantee: string | null;
      }>(
        `select p.polname,
                p.polcmd::text as polcmd,
                min(pg_get_userbyid(role_oid)) as grantee
           from pg_policy p
           cross join lateral unnest(p.polroles::oid[]) as role_oids(role_oid)
          where p.polrelid = 'public.ledger_postings'::regclass
          group by p.polname, p.polcmd
          order by p.polname`,
      );

      // Exactly four policies: three application policies routed through the
      // role helper, plus the elevated read policy the security-definer
      // balance scan needs (FORCE row level security would otherwise filter
      // savia_elevated out of its own aggregate). NO 'd' (delete) policy.
      expect(
        policiesRes.rows.map((r) => [r.polname, r.polcmd, r.grantee]),
      ).toEqual([
        ['application_inserts_workspace_posting', 'a', 'savia_application'],
        ['application_reads_workspace_posting', 'r', 'savia_application'],
        ['application_updates_workspace_posting', 'w', 'savia_application'],
        ['elevated_reads_ledger_postings', 'r', 'savia_elevated'],
      ]);
      expect(policiesRes.rows.some((r) => r.polcmd === 'd')).toBe(false);
    });

    it('6. The balance index covers exactly (workspace_id, account_id, status, occurred_at) include (amount_minor), plus single-column parent indexes', async () => {
      const balanceRes = await admin.query<{
        keycols: string[];
        allcols: string[];
        indnatts: number;
        indnkeyatts: number;
      }>(
        `select
           (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
             where k.ord <= i.indnkeyatts) as keycols,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as allcols,
           i.indnatts,
           i.indnkeyatts
          from pg_index i
          join pg_class idx on idx.oid = i.indexrelid
         where idx.relname = 'ledger_postings_balance_idx'
           and i.indisunique = false`,
      );
      expect(balanceRes.rows).toHaveLength(1);
      expect(balanceRes.rows[0].keycols).toEqual([
        'workspace_id',
        'account_id',
        'status',
        'occurred_at',
      ]);
      // INCLUDE (amount_minor): payload column beyond the 4 key columns.
      expect(balanceRes.rows[0].indnkeyatts).toBe(4);
      expect(balanceRes.rows[0].indnatts).toBe(5);
      expect(balanceRes.rows[0].allcols).toEqual([
        'workspace_id',
        'account_id',
        'status',
        'occurred_at',
        'amount_minor',
      ]);

      for (const [indexName, expected] of [
        ['ledger_postings_transaction_idx', ['transaction_id']],
        ['ledger_postings_transfer_idx', ['transfer_id']],
      ] as const) {
        const res = await admin.query<{ colnames: string[] }>(
          `select array_agg(a.attname::text order by k.ord) as colnames
             from pg_index i
             join pg_class idx on idx.oid = i.indexrelid
             join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where idx.relname = $1
              and i.indisunique = false`,
          [indexName],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].colnames).toEqual(expected);
      }
    });

    it('7. amount_minor is declared bigint in information_schema.columns (never integer, never numeric)', async () => {
      const res = await admin.query<{ data_type: string }>(
        `select data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'ledger_postings'
            and column_name = 'amount_minor'`,
      );
      expect(res.rows[0].data_type).toBe('bigint');
    });

    it('8. The balance trigger is DEFERRABLE INITIALLY DEFERRED and its function is SECURITY DEFINER owned by savia_elevated, who can really read the table through its own FORCE-RLS policy', async () => {
      // The whole invariant hangs on these structural facts:
      // - deferred + initially deferred: the legitimate intermediate state
      //   right after the FIRST leg must not be rejected;
      // - security definer owned by savia_elevated: an invoker-rights scan
      //   would be filtered by this table's own FORCE row level security and
      //   could aggregate a PARTIAL group (202607150001:3-9 blindness);
      // - savia_elevated is nobypassrls, so the grant alone yields zero rows
      //   (202607150013:11-15 precedent) — it needs its own select POLICY,
      //   pinned here, or the raise is unreachable and the "invariant" is a
      //   silent no-op.
      const triggerRes = await admin.query<{
        tgisinternal: boolean;
        tgdeferrable: boolean;
        tginitdeferred: boolean;
        tgtype: number;
        proname: string;
        prosecdef: boolean;
        proowner: string;
      }>(
        `select t.tgisinternal,
                t.tgdeferrable,
                t.tginitdeferred,
                t.tgtype,
                p.proname::text as proname,
                p.prosecdef,
                p.proowner::regrole::text as proowner
           from pg_trigger t
           join pg_proc p on p.oid = t.tgfoid
          where t.tgrelid = 'public.ledger_postings'::regclass
            and t.tgname = 'enforce_balanced_ledger_postings_from_posting'`,
      );
      expect(triggerRes.rows).toHaveLength(1);
      const trigger = triggerRes.rows[0];
      // A CREATE CONSTRAINT TRIGGER is a user trigger (tgisinternal false),
      // deferrable and INITIALLY DEFERRED.
      expect(trigger.tgisinternal).toBe(false);
      expect(trigger.tgdeferrable).toBe(true);
      expect(trigger.tginitdeferred).toBe(true);
      expect(trigger.proname).toBe('enforce_balanced_ledger_postings');
      expect(trigger.prosecdef).toBe(true);
      expect(trigger.proowner).toBe('savia_elevated');
      // FOR EACH ROW on INSERT+UPDATE+DELETE (bits 4+8+16), never BEFORE
      // (bit 2 clear). Observed tgtype for this constraint trigger is 29: the
      // deferrable columns above are what mark it, not catalog bit 128.
      expect(trigger.tgtype & 28).toBe(28);
      expect(trigger.tgtype & 2).toBe(0);

      const elevatedReadRes = await admin.query<{
        can_read: boolean;
        policy_rows: number;
        public_execute: boolean;
      }>(
        `select has_table_privilege('savia_elevated', 'public.ledger_postings', 'select') as can_read,
                (select count(*)::int from pg_policy
                  where polrelid = 'public.ledger_postings'::regclass
                    and polname = 'elevated_reads_ledger_postings') as policy_rows,
                has_function_privilege('public', 'public.enforce_balanced_ledger_postings()', 'execute') as public_execute`,
      );
      expect(elevatedReadRes.rows[0].can_read).toBe(true);
      expect(elevatedReadRes.rows[0].policy_rows).toBe(1);
      // Trigger-only helper: no direct execute path reaches it from PUBLIC.
      expect(elevatedReadRes.rows[0].public_execute).toBe(false);
    });
  });

  describe('Balanced-postings invariant (live proofs on the superuser path)', () => {
    it('9. LIVE PROOF: an unbalanced PAIR (+1000/-500 on one transaction) is REFUSED at commit with 23514 — the trigger really raises, a comment does not enforce anything', async () => {
      // Deliberately unbalanced: sums to +500. With pool autocommit the
      // deferred constraint trigger fires when this single statement commits,
      // so the REAL captured error lands on this very query.
      const unbalancedErr = await capturePgError(() =>
        admin.query(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', '1000', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                  ($1, $2, null, 'external', '-500', 'USD', 'confirmed', '2026-08-24T12:00:00Z')`,
          [ws1Id, transaction1Id, account1Id],
        ),
      );
      // Assert against the REAL captured pg error, never a hand-built literal.
      expect(unbalancedErr.code).toBe('23514');
      expect(unbalancedErr.message ?? '').toContain(
        'ledger postings must balance to zero per currency',
      );
      expect(unbalancedErr.message ?? '').not.toContain('permission denied');
      expect(unbalancedErr.message ?? '').not.toContain('row-level security');

      const leftover = await admin.query<{ n: number }>(
        `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
        [transaction1Id],
      );
      expect(leftover.rows[0].n).toBe(0);
    });

    it('10. POSITIVE CONTROL: a balanced set (account debit +1000, external credit -1000) COMMITS and persists — a trigger that refused everything cannot pass test 9', async () => {
      const inserted = await admin.query<{ id: string }>(
        `insert into public.ledger_postings
           (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, $2, $3, 'account', '1000', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                ($1, $2, null, 'external', '-1000', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
         returning id`,
        [ws1Id, transaction1Id, account1Id],
      );
      const ids = inserted.rows.map((r) => r.id);
      expect(ids).toHaveLength(2);
      try {
        const stored = await admin.query<{ n: number; total: string }>(
          `select count(*)::int as n, sum(amount_minor)::text as total
             from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        expect(stored.rows[0].n).toBe(2);
        expect(stored.rows[0].total).toBe('0');
      } finally {
        await deletePostings(ids);
      }
    });

    it('11. DEFERRAL PROOF: the set is unbalanced MID-TRANSACTION (first leg alone resolves!) but balanced by COMMIT — the whole point of deferrable initially deferred; a plain AFTER trigger fails this', async () => {
      const client = await admin.connect();
      const insertedIds: string[] = [];
      try {
        await client.query('begin');

        // Statement 1: the FIRST leg, while the set is incomplete and
        // unbalanced. A non-deferred trigger would reject THIS statement;
        // the deferred one lets it resolve.
        const firstLeg = await client.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', '2500', 'USD', 'draft', '2026-08-24T12:00:00Z')
           returning id`,
          [ws1Id, transaction1Id, account1Id],
        );
        expect(firstLeg.rowCount).toBe(1);
        insertedIds.push(firstLeg.rows[0].id);

        const midTransaction = await client.query<{ n: number }>(
          `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        // Mid-transaction the group is genuinely unbalanced: 1 leg, sum != 0.
        expect(midTransaction.rows[0].n).toBe(1);

        // Statement 2 completes the set...
        const secondLeg = await client.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, null, 'external', '-2500', 'USD', 'draft', '2026-08-24T12:00:00Z')
           returning id`,
          [ws1Id, transaction1Id],
        );
        expect(secondLeg.rowCount).toBe(1);
        insertedIds.push(secondLeg.rows[0].id);

        // ...and COMMIT must SUCCEED because the set balances by then.
        await client.query('commit');
      } finally {
        await client.query('rollback').catch(() => {});
        client.release();
        await deletePostings(insertedIds);
      }

      const gone = await admin.query<{ n: number }>(
        `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
        [transaction1Id],
      );
      expect(gone.rows[0].n).toBe(0);
    });

    it('12. A transfer-parented balanced pair also commits: nullable transaction_id skips the composite FK (MATCH SIMPLE), proving the transfer-parent shape is representable', async () => {
      const transferId = randomUUID();
      const inserted = await admin.query<{ id: string }>(
        `insert into public.ledger_postings
           (workspace_id, transaction_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, null, $2, $3, 'account', '400', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                ($1, null, $2, null, 'external', '-400', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
         returning id`,
        [ws1Id, transferId, account1Id],
      );
      const ids = inserted.rows.map((r) => r.id);
      expect(ids).toHaveLength(2);
      try {
        const stored = await admin.query<{ total: string }>(
          `select sum(amount_minor)::text as total
             from public.ledger_postings where transfer_id = $1`,
          [transferId],
        );
        expect(stored.rows[0].total).toBe('0');
      } finally {
        await deletePostings(ids);
      }
    });
  });

  describe('Constraints (superuser isolation: only the CHECK can refuse)', () => {
    it("13. status has NO 'voided' value — the CHECK refuses it with 23514 naming ledger_postings_status_check, the constraint definition enumerates exactly the four legal values, and 'reconciled' is accepted on the identical path", async () => {
      // A void APPENDS a reversing set; it never restates a posting (RULING
      // 29). If 'voided' existed here, the balance query would need a status
      // special-case, and the whole design depends on it not needing one.
      const voidedErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction1Id,
          accountId: account1Id,
          legKind: 'account',
          amountMinor: '100',
          status: 'voided',
        }),
      );
      expect(voidedErr.code).toBe('23514');
      expect(voidedErr.message ?? '').toContain('check constraint');
      expect(voidedErr.message ?? '').toContain('ledger_postings_status_check');
      expect(voidedErr.message ?? '').not.toContain('row-level security');
      expect(voidedErr.message ?? '').not.toContain('permission denied');

      // Structural pin: the definition itself carries no 'voided'.
      const defRes = await admin.query<{ conname: string; def: string }>(
        `select conname, pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.ledger_postings'::regclass
            and conname = 'ledger_postings_status_check'`,
      );
      expect(defRes.rows).toHaveLength(1);
      for (const allowed of ['draft', 'pending', 'confirmed', 'reconciled']) {
        expect(defRes.rows[0].def).toContain(allowed);
      }
      expect(defRes.rows[0].def).not.toContain('voided');

      // Positive control on the identical path: the same single-statement
      // superuser insert with 'reconciled' commits (as part of a balanced
      // pair, because a lone leg can never survive the balance trigger).
      const okIds = await seedBalancedPair({
        workspaceId: ws1Id,
        transactionId: transaction1Id,
        accountId: account1Id,
        amountMinor: '130',
        accountStatus: 'reconciled',
      });
      try {
        const check = await admin.query<{ n: number }>(
          `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await deletePostings(okIds);
      }
    });

    it('14. num_nonnulls(transaction_id, transfer_id) = 1 refuses TWO parents and ZERO parents with 23514 naming ledger_postings_parent_exactly_one_check; exactly one parent is accepted', async () => {
      const twoParentsErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction1Id,
          transferId: randomUUID(),
          accountId: account1Id,
          legKind: 'account',
          amountMinor: '100',
        }),
      );
      expect(twoParentsErr.code).toBe('23514');
      expect(twoParentsErr.message ?? '').toContain('check constraint');
      expect(twoParentsErr.message ?? '').toContain(
        'ledger_postings_parent_exactly_one_check',
      );

      const zeroParentsErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          accountId: null,
          legKind: 'external',
          amountMinor: '100',
        }),
      );
      expect(zeroParentsErr.code).toBe('23514');
      expect(zeroParentsErr.message ?? '').toContain(
        'ledger_postings_parent_exactly_one_check',
      );
      expect(zeroParentsErr.message ?? '').not.toContain('row-level security');
      expect(zeroParentsErr.message ?? '').not.toContain('permission denied');

      // Positive control on the identical path: exactly-one-parent rows
      // commit (a balanced transfer-parented pair, one statement).
      const transferId = randomUUID();
      const okInsert = await admin.query<{ id: string }>(
        `insert into public.ledger_postings
           (workspace_id, transaction_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, null, $2, null, 'external', '100', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                ($1, null, $2, null, 'external', '-100', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
         returning id`,
        [ws1Id, transferId],
      );
      const okIds = okInsert.rows.map((r) => r.id);
      try {
        const check = await admin.query<{ n: number }>(
          'select count(*)::int as n from public.ledger_postings where id = any($1::uuid[])',
          [okIds],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await deletePostings(okIds);
      }
    });

    it("15. check ((leg_kind = 'account') = (account_id is not null)) refuses BOTH directions with 23514 naming ledger_postings_account_leg_parity_check; both valid shapes are accepted", async () => {
      const externalWithAccountErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction1Id,
          accountId: account1Id,
          legKind: 'external',
          amountMinor: '100',
        }),
      );
      expect(externalWithAccountErr.code).toBe('23514');
      expect(externalWithAccountErr.message ?? '').toContain(
        'check constraint',
      );
      expect(externalWithAccountErr.message ?? '').toContain(
        'ledger_postings_account_leg_parity_check',
      );

      const accountWithoutAccountErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction1Id,
          accountId: null,
          legKind: 'account',
          amountMinor: '100',
        }),
      );
      expect(accountWithoutAccountErr.code).toBe('23514');
      expect(accountWithoutAccountErr.message ?? '').toContain(
        'ledger_postings_account_leg_parity_check',
      );
      expect(accountWithoutAccountErr.message ?? '').not.toContain(
        'row-level security',
      );
      expect(accountWithoutAccountErr.message ?? '').not.toContain(
        'permission denied',
      );

      // Positive controls: both valid shapes in one balanced set on the
      // identical superuser path.
      const okIds = await seedBalancedPair({
        workspaceId: ws1Id,
        transactionId: transaction1Id,
        accountId: account1Id,
        amountMinor: '140',
      });
      try {
        const shapes = await admin.query<{
          account_legs: number;
          external_legs: number;
        }>(
          `select count(*) filter (where leg_kind = 'account')::int as account_legs,
                  count(*) filter (where leg_kind = 'external')::int as external_legs
             from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        expect(shapes.rows[0].account_legs).toBe(1);
        expect(shapes.rows[0].external_legs).toBe(1);
      } finally {
        await deletePostings(okIds);
      }
    });

    it("16. The currency check refuses 'usd' with 23514; precedent 202607150001:11,20", async () => {
      const err = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction1Id,
          accountId: account1Id,
          legKind: 'account',
          amountMinor: '100',
          currency: 'usd',
        }),
      );
      expect(err.code).toBe('23514');
    });
  });

  describe('Composite foreign keys (RULING 48, superuser isolation: only the FK can refuse)', () => {
    it('17. A posting whose account belongs to a DIFFERENT workspace is refused with 23503 naming ledger_postings_account_workspace_fkey — RI checks bypass row security, so only the COMPOSITE key closes the hole', async () => {
      const crossErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction1Id,
          accountId: account2Id,
          legKind: 'account',
          amountMinor: '100',
        }),
      );
      expect(crossErr.code).toBe('23503');
      expect(crossErr.message ?? '').toContain(
        'violates foreign key constraint',
      );
      // Pin the CONCRETE constraint name, not just the message family.
      expect(crossErr.message ?? '').toContain(
        'ledger_postings_account_workspace_fkey',
      );
      expect(crossErr.message ?? '').not.toContain('row-level security');
      expect(crossErr.message ?? '').not.toContain('permission denied');

      // Structural pin: the composite shape with restrict, so a revert to a
      // single-column FK cannot pass silently.
      const fkRes = await admin.query<{ def: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as def, confdeltype
           from pg_constraint
          where conrelid = 'public.ledger_postings'::regclass
            and conname = 'ledger_postings_account_workspace_fkey'`,
      );
      expect(fkRes.rows).toHaveLength(1);
      expect(fkRes.rows[0].def).toMatch(
        /foreign key \(workspace_id, account_id\) references accounts\(workspace_id, id\) on delete restrict/i,
      );
      expect(fkRes.rows[0].confdeltype).toBe('r');
    });

    it('18. Positive control on the identical path: the same posting with a SAME-WORKSPACE account succeeds', async () => {
      const okIds = await seedBalancedPair({
        workspaceId: ws1Id,
        transactionId: transaction1Id,
        accountId: account1Id,
        amountMinor: '110',
      });
      expect(okIds).toHaveLength(2);
      try {
        const check = await admin.query<{ n: number }>(
          `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await deletePostings(okIds);
      }
    });

    it('19. A posting whose transaction belongs to a DIFFERENT workspace is refused with 23503 naming ledger_postings_transaction_workspace_fkey', async () => {
      const crossErr = await capturePgError(() =>
        seedPosting({
          workspaceId: ws1Id,
          transactionId: transaction2Id,
          accountId: account1Id,
          legKind: 'account',
          amountMinor: '100',
        }),
      );
      expect(crossErr.code).toBe('23503');
      expect(crossErr.message ?? '').toContain(
        'violates foreign key constraint',
      );
      expect(crossErr.message ?? '').toContain(
        'ledger_postings_transaction_workspace_fkey',
      );
      expect(crossErr.message ?? '').not.toContain('row-level security');
      expect(crossErr.message ?? '').not.toContain('permission denied');

      // Structural pin, plus: no SINGLE-COLUMN foreign key against either
      // sibling exists (a revert cannot pass silently), and the table carries
      // exactly three FKs — the two composites plus the workspace cascade.
      const fkRes = await admin.query<{ def: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as def, confdeltype
           from pg_constraint
          where conrelid = 'public.ledger_postings'::regclass
            and conname = 'ledger_postings_transaction_workspace_fkey'`,
      );
      expect(fkRes.rows).toHaveLength(1);
      expect(fkRes.rows[0].def).toMatch(
        /foreign key \(workspace_id, transaction_id\) references transactions\(workspace_id, id\) on delete restrict/i,
      );
      expect(fkRes.rows[0].confdeltype).toBe('r');

      const countRes = await admin.query<{
        total: number;
        single_column_siblings: number;
      }>(
        `select count(*)::int as total,
                count(*) filter (
                  where c.confrelid in ('public.accounts'::regclass, 'public.transactions'::regclass)
                    and cardinality(c.conkey) <> 2
                )::int as single_column_siblings
           from pg_constraint c
          where c.conrelid = 'public.ledger_postings'::regclass
            and c.contype = 'f'`,
      );
      expect(countRes.rows[0].total).toBe(3);
      expect(countRes.rows[0].single_column_siblings).toBe(0);
    });

    it('20. Positive control on the identical path: the same posting with a SAME-WORKSPACE transaction succeeds', async () => {
      const okInsert = await admin.query<{ id: string }>(
        `insert into public.ledger_postings
           (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
         values ($1, $2, null, 'external', '50', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                ($1, $2, null, 'external', '-50', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
         returning id`,
        [ws1Id, transaction1Id],
      );
      const okIds = okInsert.rows.map((r) => r.id);
      expect(okIds).toHaveLength(2);
      try {
        const check = await admin.query<{ n: number }>(
          'select count(*)::int as n from public.ledger_postings where id = any($1::uuid[])',
          [okIds],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await deletePostings(okIds);
      }
    });

    it('21. ON DELETE RESTRICT, both directions: deleting a referenced TRANSACTION or ACCOUNT while postings exist is refused with 23503 naming the concrete foreign key; after the postings go, the same deletes succeed', async () => {
      const dispWsId = '00000000-0000-0000-0000-000000000754';
      const dispMemId = '00000000-0000-0000-0000-000000000716';
      const dispAccId = '00000000-0000-0000-0000-000000000774';
      const dispTxId = '00000000-0000-0000-0000-000000000784';
      // A SECOND account with NO transaction pointing at it: its only
      // referencer will be transfer-parented postings, so the account-delete
      // refusal has exactly one possible refuser — ours.
      const dispAcc2Id = '00000000-0000-0000-0000-000000000776';

      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Ledger Restrict WS', 'shared', 'USD', $2)`,
        [dispWsId, ownerA],
      );
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [dispMemId, dispWsId, ownerA],
      );
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
         values ($1, $2, 'Ledger Restrict Account', 'cash', 'USD', $3),
                ($4, $5, 'Ledger Restrict Account 2', 'cash', 'USD', $6)`,
        [dispAccId, dispWsId, ownerA, dispAcc2Id, dispWsId, ownerA],
      );
      await admin.query(
        `insert into public.transactions
           (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'income', 'confirmed', '500', 'USD', '2026-08-24T12:00:00Z', $4)`,
        [dispTxId, dispWsId, dispAccId, ownerA],
      );
      // Two complete sets, one statement each: a transaction-parented pair
      // (pins the transaction side) and a transfer-parented pair on the
      // second account (pins the account side unambiguously).
      const txPairIds = (
        await admin.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', '500', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                  ($1, $2, null, 'external', '-500', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
           returning id`,
          [dispWsId, dispTxId, dispAccId],
        )
      ).rows.map((r) => r.id);
      const transferId = randomUUID();
      const accPairIds = (
        await admin.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, transfer_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, null, $2, $3, 'account', '200', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                  ($1, null, $2, null, 'external', '-200', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
           returning id`,
          [dispWsId, transferId, dispAcc2Id],
        )
      ).rows.map((r) => r.id);
      expect(txPairIds).toHaveLength(2);
      expect(accPairIds).toHaveLength(2);

      try {
        // Direction 1: the transaction's only referencers are OUR postings —
        // the refusal is unambiguously ours.
        const txDelErr = await capturePgError(() =>
          admin.query('delete from public.transactions where id = $1', [
            dispTxId,
          ]),
        );
        expect(txDelErr.code).toBe('23503');
        expect(txDelErr.message ?? '').toContain(
          'violates foreign key constraint',
        );
        expect(txDelErr.message ?? '').toContain(
          'ledger_postings_transaction_workspace_fkey',
        );

        // Direction 2: dispAcc2 is referenced by NOTHING but our postings —
        // again exactly one possible refuser.
        const accDelErr = await capturePgError(() =>
          admin.query('delete from public.accounts where id = $1', [
            dispAcc2Id,
          ]),
        );
        expect(accDelErr.code).toBe('23503');
        expect(accDelErr.message ?? '').toContain(
          'violates foreign key constraint',
        );
        expect(accDelErr.message ?? '').toContain(
          'ledger_postings_account_workspace_fkey',
        );
      } finally {
        await deletePostings([...txPairIds, ...accPairIds]);
      }

      // Positive controls: with the referencing postings gone, restrict no
      // longer fires — proving the refusals above came from THESE foreign keys.
      await admin.query('delete from public.transactions where id = $1', [
        dispTxId,
      ]);
      await admin.query(
        'delete from public.accounts where id = any($1::uuid[])',
        [[dispAccId, dispAcc2Id]],
      );
      await admin.query('delete from public.workspaces where id = $1', [
        dispWsId,
      ]);
      const gone = await admin.query<{ n: number }>(
        'select count(*)::int as n from public.accounts where id = $1',
        [dispAcc2Id],
      );
      expect(gone.rows[0].n).toBe(0);
    });

    it('22. REGRESSION (the DoS RULING 48 removes): deleting a workspace whose account AND transaction are referenced by its OWN postings SUCCEEDS — everything dies together in the cascade', async () => {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Ledger DoS WS', 'shared', 'USD', $2)`,
        [dosWsId, ownerA],
      );
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        ['00000000-0000-0000-0000-000000000717', dosWsId, ownerA],
      );
      const dosAccId = '00000000-0000-0000-0000-000000000775';
      const dosTxId = '00000000-0000-0000-0000-000000000785';
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
         values ($1, $2, 'Ledger DoS Account', 'cash', 'USD', $3)`,
        [dosAccId, dosWsId, ownerA],
      );
      await admin.query(
        `insert into public.transactions
           (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
         values ($1, $2, $3, 'income', 'confirmed', '900', 'USD', '2026-08-24T12:00:00Z', $4)`,
        [dosTxId, dosWsId, dosAccId, ownerA],
      );
      const postingIds = (
        await admin.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', '900', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                  ($1, $2, null, 'external', '-900', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
           returning id`,
          [dosWsId, dosTxId, dosAccId],
        )
      ).rows.map((r) => r.id);
      expect(postingIds).toHaveLength(2);

      // Before the fix shape (single-column FKs) a cross-workspace poison row
      // bricked this delete permanently with 23503. After it, EVERY reference
      // is necessarily same-workspace, so the cascade takes postings,
      // transactions and accounts down together and the delete MUST succeed.
      await admin.query('delete from public.workspaces where id = $1', [
        dosWsId,
      ]);

      const postingGone = await admin.query<{ n: number }>(
        `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
        [dosTxId],
      );
      expect(postingGone.rows[0].n).toBe(0);

      const txGone = await admin.query<{ n: number }>(
        'select count(*)::int as n from public.transactions where id = $1',
        [dosTxId],
      );
      expect(txGone.rows[0].n).toBe(0);

      const accGone = await admin.query<{ n: number }>(
        'select count(*)::int as n from public.accounts where id = $1',
        [dosAccId],
      );
      expect(accGone.rows[0].n).toBe(0);

      const wsGone = await admin.query<{ n: number }>(
        'select count(*)::int as n from public.workspaces where id = $1',
        [dosWsId],
      );
      expect(wsGone.rows[0].n).toBe(0);
    });
  });

  describe('RLS behaviour', () => {
    it('23. Positive control: an OWNER inserts a complete balanced set THROUGH the insert policy and grants, proving the policy passes complete sets', async () => {
      let insertedIds: string[] = [];
      try {
        insertedIds = await asSubject(ownerA, async (client) => {
          const legs = await client.query<{ id: string }>(
            `insert into public.ledger_postings
               (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
             values ($1, $2, $3, 'account', '750', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                    ($1, $2, null, 'external', '-750', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
             returning id`,
            [ws1Id, transaction1Id, account1Id],
          );
          return legs.rows.map((r) => r.id);
        });
        expect(insertedIds).toHaveLength(2);

        const check = await admin.query<{ n: number }>(
          `select count(*)::int as n from public.ledger_postings where transaction_id = $1`,
          [transaction1Id],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await deletePostings(insertedIds);
      }
    });

    it('24. A VIEWER CANNOT insert — refused with 42501 by the POLICY ("new row violates row-level security policy"), NOT by a missing grant; the identical insert by an owner succeeds in the same test', async () => {
      // The attempted insert names ONLY columns covered by the column-scoped
      // insert grant. The owner control below runs the identical statement
      // successfully (as part of a balanced set), so the grant demonstrably
      // covers these columns and the viewer's refusal can only come from the
      // policy's role list.
      const viewerErr = await capturePgError(() =>
        asSubject(viewerE, (client) =>
          client.query(
            `insert into public.ledger_postings
               (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
             values ($1, $2, $3, 'account', '300', 'USD', 'confirmed', '2026-08-24T12:00:00Z')`,
            [ws1Id, transaction1Id, account1Id],
          ),
        ),
      );
      expect(viewerErr.code).toBe('42501');
      expect(viewerErr.message ?? '').toContain('row-level security policy');
      expect(viewerErr.message ?? '').not.toContain('permission denied');

      const controlIds = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `insert into public.ledger_postings
             (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
           values ($1, $2, $3, 'account', '300', 'USD', 'confirmed', '2026-08-24T12:00:00Z'),
                  ($1, $2, null, 'external', '-300', 'USD', 'confirmed', '2026-08-24T12:00:00Z')
           returning id`,
          [ws1Id, transaction1Id, account1Id],
        );
        return res.rows.map((r) => r.id);
      });
      try {
        const check = await admin.query<{ n: number }>(
          'select count(*)::int as n from public.ledger_postings where id = any($1::uuid[])',
          [controlIds],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await deletePostings(controlIds);
      }
    });

    it('25. An EDITOR CANNOT update amount_minor — refused by the COLUMN-SCOPED GRANT ("permission denied", NOT a row-level-security message); has_column_privilege pins the structural fact; positive control: the same editor updates status', async () => {
      const targetIds = await seedBalancedPair({
        workspaceId: ws1Id,
        transactionId: transaction1Id,
        accountId: account1Id,
        amountMinor: '600',
      });
      try {
        const grantRes = await admin.query<{
          amount_updatable: boolean;
          status_updatable: boolean;
        }>(
          `select has_column_privilege('savia_application', 'public.ledger_postings', 'amount_minor', 'update') as amount_updatable,
                  has_column_privilege('savia_application', 'public.ledger_postings', 'status', 'update') as status_updatable`,
        );
        expect(grantRes.rows[0].amount_updatable).toBe(false);
        expect(grantRes.rows[0].status_updatable).toBe(true);

        // amount_minor = amount_minor keeps the set balanced, so if the GRANT
        // were widened the statement would simply succeed — making this test
        // fail on "expected the statement to fail" rather than on some
        // unrelated balance error.
        const seizureErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              'update public.ledger_postings set amount_minor = amount_minor where id = $1',
              [targetIds[0]],
            ),
          ),
        );
        expect(seizureErr.code).toBe('42501');
        expect(seizureErr.message ?? '').toContain('permission denied');
        expect(seizureErr.message ?? '').not.toContain(
          'row-level security policy',
        );

        const untouched = await admin.query<{ amount_minor: string }>(
          'select amount_minor::text as amount_minor from public.ledger_postings where id = $1',
          [targetIds[0]],
        );
        expect(untouched.rows[0].amount_minor).toBe('600');

        // Positive control: the SAME editor CAN update the granted column.
        const flipRes = await asSubject(editorD, (client) =>
          client.query(
            `update public.ledger_postings set status = 'reconciled' where id = $1`,
            [targetIds[0]],
          ),
        );
        expect(flipRes.rowCount).toBe(1);

        const stored = await admin.query<{ status: string }>(
          'select status from public.ledger_postings where id = $1',
          [targetIds[0]],
        );
        expect(stored.rows[0].status).toBe('reconciled');
      } finally {
        await deletePostings(targetIds);
      }
    });

    it('26. No delete is possible, BY GRANT: DELETE raises 42501 with a permission-denied message, not a row-level-security one', async () => {
      const targetIds = await seedBalancedPair({
        workspaceId: ws1Id,
        transactionId: transaction1Id,
        accountId: account1Id,
        amountMinor: '150',
      });
      try {
        const delErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query('delete from public.ledger_postings where id = $1', [
              targetIds[0],
            ]),
          ),
        );
        expect(delErr.code).toBe('42501');
        expect(delErr.message ?? '').toContain('permission denied');
        expect(delErr.message ?? '').not.toContain('row-level security policy');

        const stillThere = await admin.query<{ n: number }>(
          'select count(*)::int as n from public.ledger_postings where id = any($1::uuid[])',
          [targetIds],
        );
        expect(stillThere.rows[0].n).toBe(2);
      } finally {
        await deletePostings(targetIds);
      }
    });

    it('27. An owner reads workspace postings, a viewer reads them too, an outsider reads none', async () => {
      const visibleIds = await seedBalancedPair({
        workspaceId: ws1Id,
        transactionId: transaction1Id,
        accountId: account1Id,
        amountMinor: '80',
      });
      try {
        const ownerRes = await asSubject(ownerA, (client) =>
          client.query(
            'select id from public.ledger_postings where workspace_id = $1',
            [ws1Id],
          ),
        );
        expect(ownerRes.rows.map((r) => r.id)).toEqual(
          expect.arrayContaining(visibleIds),
        );

        const viewerRes = await asSubject(viewerE, (client) =>
          client.query(
            'select id from public.ledger_postings where workspace_id = $1',
            [ws1Id],
          ),
        );
        expect(viewerRes.rows.map((r) => r.id)).toEqual(
          expect.arrayContaining(visibleIds),
        );

        const outsiderRes = await asSubject(outsiderZ, (client) =>
          client.query(
            'select id from public.ledger_postings where workspace_id = $1',
            [ws1Id],
          ),
        );
        expect(outsiderRes.rows).toHaveLength(0);
      } finally {
        await deletePostings(visibleIds);
      }
    });
  });
});
