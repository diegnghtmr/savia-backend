// Migrations under test: 202608240003_transaction_tables.sql,
// 202608240004_transaction_account_workspace_binding.sql,
// 202608290005_transaction_catalog_bindings.sql
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

describe('Workspace transactions schema, constraints, RLS, and grants (202608240003_transaction_tables.sql)', () => {
  let admin: Pool;

  const ownerA = subject(801);
  const adminC = subject(802);
  const editorD = subject(803);
  const viewerE = subject(804);
  const outsiderZ = subject(805);
  const ownerB = subject(806);

  const ws1Id = '00000000-0000-0000-0000-000000000851';
  const ws2Id = '00000000-0000-0000-0000-000000000852';

  const memOwnerAId = '00000000-0000-0000-0000-000000000861';
  const memAdminCId = '00000000-0000-0000-0000-000000000862';
  const memEditorDId = '00000000-0000-0000-0000-000000000863';
  const memViewerEId = '00000000-0000-0000-0000-000000000864';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000000865';

  const account1Id = '00000000-0000-0000-0000-000000000871';
  const account2Id = '00000000-0000-0000-0000-000000000872';

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

  async function seedTransaction(
    id: string,
    workspaceId: string,
    accountId: string,
    createdBy: string,
    overrides: {
      type?: string;
      status?: string;
      amountMinor?: string;
      currency?: string;
      occurredAt?: string;
      description?: string | null;
      categoryId?: string | null;
      payeeId?: string | null;
      voidedAt?: string | null;
    } = {},
  ): Promise<void> {
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency,
          occurred_at, description, category_id, payee_id, created_by, voided_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        workspaceId,
        accountId,
        overrides.type ?? 'income',
        overrides.status ?? 'confirmed',
        overrides.amountMinor ?? '12345',
        overrides.currency ?? 'USD',
        overrides.occurredAt ?? '2026-08-24T12:00:00Z',
        overrides.description ?? 'Seeded transaction',
        overrides.categoryId ?? null,
        overrides.payeeId ?? null,
        createdBy,
        overrides.voidedAt ?? null,
      ],
    );
  }

  async function deleteTransactions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await admin.query('delete from public.transactions where id = any($1)', [
      ids,
    ]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        ownerA,
        'tx-owner-a@example.test',
        adminC,
        'tx-admin-c@example.test',
        editorD,
        'tx-editor-d@example.test',
        viewerE,
        'tx-viewer-e@example.test',
        outsiderZ,
        'tx-outsider-z@example.test',
        ownerB,
        'tx-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'tx-owner-a@example.test', 'Tx Owner A'],
      [adminC, 'tx-admin-c@example.test', 'Tx Admin C'],
      [editorD, 'tx-editor-d@example.test', 'Tx Editor D'],
      [viewerE, 'tx-viewer-e@example.test', 'Tx Viewer E'],
      [outsiderZ, 'tx-outsider-z@example.test', 'Tx Outsider Z'],
      [ownerB, 'tx-owner-b@example.test', 'Tx Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Transactions Shared Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Transactions Shared Workspace 2', 'shared', 'USD', null, $4)`,
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

    // The transactions table takes a foreign key to public.accounts, so the
    // RLS tests need one live account per workspace to point at.
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
       values ($1, $2, 'Transactions Test Account 1', 'cash', 'USD', $3),
              ($4, $5, 'Transactions Test Account 2', 'cash', 'USD', $6)`,
      [account1Id, ws1Id, ownerA, account2Id, ws2Id, ownerB],
    );
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe('Structure and ACL', () => {
    it('1. The fitness:financial tag is present and apostrophe-free on public.transactions', async () => {
      const res = await admin.query<{ description: string | null }>(
        `select obj_description('public.transactions'::regclass) as description`,
      );

      const description = res.rows[0].description;
      expect(description).not.toBeNull();
      expect(description).toContain('fitness:financial');
      // An apostrophe inside the comment text makes
      // scripts/verify-financial-tables.mjs stop matching the tag, so the table
      // silently escapes the workspace_id rule. Pin the text itself.
      expect(description).not.toContain("'");
    });

    it('2. public.transactions has relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
         from pg_class
         where oid = 'public.transactions'::regclass`,
      );
      expect(rlsRes.rows[0].relrowsecurity).toBe(true);
      expect(rlsRes.rows[0].relforcerowsecurity).toBe(true);
    });

    it('3. savia_application holds SELECT on every column, INSERT on exactly (account_id, amount_minor, category_id, created_by, currency, description, import_job_id, notes, occurred_at, payee_id, receipt_id, status, tag_ids, type, workspace_id), UPDATE on exactly (category_id, description, import_job_id, notes, occurred_at, payee_id, status, tag_ids, updated_at, version, voided_at)', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.transactions', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.transactions', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.transactions', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'transactions'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'account_id',
        'amount_minor',
        'category_id',
        'created_at',
        'created_by',
        'currency',
        'description',
        'id',
        'import_job_id',
        'notes',
        'occurred_at',
        'payee_id',
        'receipt_id',
        'reconciliation_id',
        'source',
        'status',
        'tag_ids',
        'type',
        'updated_at',
        'version',
        'voided_at',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'account_id',
        'amount_minor',
        'category_id',
        'created_by',
        'currency',
        'description',
        'import_job_id',
        'notes',
        'occurred_at',
        'payee_id',
        'receipt_id',
        'status',
        'tag_ids',
        'type',
        'workspace_id',
      ]);

      // workspace_id and account_id are deliberately ABSENT from UPDATE: a
      // table-wide grant would let a write path re-point a transaction into
      // another workspace or onto another account and seize it
      // (202607150011:10-14, 202607150014:58-59). source, reconciliation_id and
      // amount_minor are absent too: no contract request can carry them
      // (CreateTransactionRequest/UpdateTransactionRequest in the authority),
      // so no write path may exercise them yet.
      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([
        'category_id',
        'description',
        'import_job_id',
        'notes',
        'occurred_at',
        'payee_id',
        'status',
        'tag_ids',
        'updated_at',
        'version',
        'voided_at',
      ]);
    });

    it('4. There is NO splits column — asserted positively via information_schema.columns — and the complete column inventory is pinned', async () => {
      const absenceRes = await admin.query<{ splits_columns: number }>(
        `select count(*)::int as splits_columns
            from information_schema.columns
           where table_schema = 'public'
             and table_name = 'transactions'
             and column_name = 'splits'`,
      );
      expect(absenceRes.rows[0].splits_columns).toBe(0);

      // And the complete column inventory is pinned, so ANY added column — a
      // splits under another name included — fails this test too. RULING 33
      // refuses splits with a 422 until Epica 4 ships categories; a dead
      // column nothing may populate must not exist.
      const inventoryRes = await admin.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'transactions'
          order by column_name`,
      );
      expect(inventoryRes.rows.map((r) => r.column_name)).toEqual([
        'account_id',
        'amount_minor',
        'category_id',
        'created_at',
        'created_by',
        'currency',
        'description',
        'id',
        'import_job_id',
        'notes',
        'occurred_at',
        'payee_id',
        'receipt_id',
        'reconciliation_id',
        'source',
        'status',
        'tag_ids',
        'type',
        'updated_at',
        'version',
        'voided_at',
        'workspace_id',
      ]);
    });

    it('5. savia_application holds NO delete privilege on public.transactions (transactions are voided, never deleted)', async () => {
      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.transactions', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);
    });

    it('6. The listTransactions keyset index exists on exactly (workspace_id, occurred_at, id) and the closeAccount precondition index on exactly (workspace_id, account_id, status)', async () => {
      const keysetRes = await admin.query<{ colnames: string[] }>(
        `select array_agg(a.attname::text order by k.ord) as colnames
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'transactions_workspace_occurred_keyset_idx'
            and i.indisunique = false`,
      );
      expect(keysetRes.rows).toHaveLength(1);
      expect(keysetRes.rows[0].colnames).toEqual([
        'workspace_id',
        'occurred_at',
        'id',
      ]);

      const statusRes = await admin.query<{ colnames: string[] }>(
        `select array_agg(a.attname::text order by k.ord) as colnames
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'transactions_workspace_account_status_idx'
            and i.indisunique = false`,
      );
      expect(statusRes.rows).toHaveLength(1);
      expect(statusRes.rows[0].colnames).toEqual([
        'workspace_id',
        'account_id',
        'status',
      ]);
    });

    it('7. amount_minor is declared bigint in information_schema.columns (never integer, never numeric)', async () => {
      const res = await admin.query<{ data_type: string }>(
        `select data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'transactions'
            and column_name = 'amount_minor'`,
      );
      expect(res.rows[0].data_type).toBe('bigint');
    });
  });

  describe('Constraints', () => {
    it("8. The type check refuses 'transfer' with 23514 — refused by the CHECK CONSTRAINT (run as superuser admin, so neither RLS nor grants can be the refuser); positive control accepts an allowed type", async () => {
      // The absence of 'transfer' is a deliberate ruling (FR-LED-005, RULING
      // 32): prove the value is genuinely rejected, not silently accepted.
      const transferErr = await capturePgError(() =>
        seedTransaction(subject(881), ws1Id, account1Id, ownerA, {
          type: 'transfer',
        }),
      );
      expect(transferErr.code).toBe('23514');
      expect(transferErr.message ?? '').toContain('check constraint');
      expect(transferErr.message ?? '').toContain('transactions_type_check');
      expect(transferErr.message ?? '').not.toContain('row-level security');
      expect(transferErr.message ?? '').not.toContain('permission denied');

      // Structural pin: the constraint definition enumerates exactly the six
      // allowed types and contains no 'transfer'.
      const defRes = await admin.query<{ conname: string; def: string }>(
        `select conname, pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.transactions'::regclass
            and conname = 'transactions_type_check'`,
      );
      expect(defRes.rows).toHaveLength(1);
      for (const allowed of [
        'income',
        'expense',
        'adjustment',
        'refund',
        'debt_payment',
        'fund_contribution',
      ]) {
        expect(defRes.rows[0].def).toContain(allowed);
      }
      expect(defRes.rows[0].def).not.toContain('transfer');

      // Positive control: an allowed type inserts fine under identical
      // conditions (same actor-less superuser path), isolating the refusal to
      // the type value itself.
      const okId = subject(881);
      try {
        await seedTransaction(okId, ws1Id, account1Id, ownerA, {
          type: 'debt_payment',
          description: 'Type positive control',
        });
        const check = await admin.query(
          'select 1 from public.transactions where id = $1',
          [okId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        await deleteTransactions([okId]);
      }
    });

    it("9. The currency check refuses 'usd' with 23514; precedent 202607150001:11,20", async () => {
      const err = await capturePgError(() =>
        seedTransaction(subject(882), ws1Id, account1Id, ownerA, {
          currency: 'usd',
        }),
      );
      expect(err.code).toBe('23514');
    });

    it('10. amount_minor accepts a NEGATIVE value and a value beyond 32-bit range, round-tripping exactly — proving bigint, not integer', async () => {
      // If the column were integer, PostgreSQL would refuse both inserts with
      // 22003 "integer out of range"; node-pg returns int8 as string, so the
      // exact round-trip also rules out any float narrowing.
      const bigId = subject(883);
      const negativeId = subject(884);
      try {
        await seedTransaction(bigId, ws1Id, account1Id, ownerA, {
          amountMinor: '9876543210123',
        });
        await seedTransaction(negativeId, ws1Id, account1Id, ownerA, {
          amountMinor: '-9876543210123',
        });
        const check = await admin.query<{
          id: string;
          amount_minor: string;
        }>(
          'select id, amount_minor::text as amount_minor from public.transactions where id in ($1, $2)',
          [bigId, negativeId],
        );
        const byId = new Map(check.rows.map((r) => [r.id, r.amount_minor]));
        expect(byId.get(bigId)).toBe('9876543210123');
        expect(byId.get(negativeId)).toBe('-9876543210123');
      } finally {
        await deleteTransactions([bigId, negativeId]);
      }
    });

    it("11. check ((status = 'voided') = (voided_at is not null)) refuses BOTH directions with 23514: a voided row with null voided_at and a live row with a set voided_at; positive controls accept both valid shapes", async () => {
      const voidedNullErr = await capturePgError(() =>
        seedTransaction(subject(885), ws1Id, account1Id, ownerA, {
          status: 'voided',
          voidedAt: null,
        }),
      );
      expect(voidedNullErr.code).toBe('23514');
      expect(voidedNullErr.message ?? '').toContain('check constraint');

      const liveSetErr = await capturePgError(() =>
        seedTransaction(subject(885), ws1Id, account1Id, ownerA, {
          status: 'draft',
          voidedAt: new Date().toISOString(),
        }),
      );
      expect(liveSetErr.code).toBe('23514');
      expect(liveSetErr.message ?? '').toContain('check constraint');

      const okVoidedId = subject(885);
      const okLiveId = subject(886);
      try {
        await seedTransaction(okVoidedId, ws1Id, account1Id, ownerA, {
          status: 'voided',
          voidedAt: new Date().toISOString(),
        });
        await seedTransaction(okLiveId, ws1Id, account1Id, ownerA, {
          status: 'draft',
          voidedAt: null,
        });
        const check = await admin.query(
          'select id, status, voided_at from public.transactions where id in ($1, $2)',
          [okVoidedId, okLiveId],
        );
        expect(check.rows).toHaveLength(2);
      } finally {
        await deleteTransactions([okVoidedId, okLiveId]);
      }
    });

    it('12. Deleting a referenced profile (created_by) is REFUSED with 23503, proving on delete restrict', async () => {
      const disposableProfileId = subject(807);
      await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [
        disposableProfileId,
        'tx-disposable-creator@example.test',
      ]);
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, 'Tx Disposable Creator', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [disposableProfileId, 'tx-disposable-creator@example.test'],
      );

      const txId = subject(887);
      try {
        await seedTransaction(txId, ws1Id, account1Id, disposableProfileId);
        await expect(
          admin.query('delete from public.profiles where id = $1', [
            disposableProfileId,
          ]),
        ).rejects.toMatchObject({ code: '23503' });
      } finally {
        await deleteTransactions([txId]);
        await admin.query('delete from public.profiles where id = $1', [
          disposableProfileId,
        ]);
        await admin.query('delete from auth.users where id = $1', [
          disposableProfileId,
        ]);
      }
    });

    it('13. Deleting a workspace cascades its transactions away', async () => {
      const disposableWsId = '00000000-0000-0000-0000-000000000853';
      const disposableMemId = '00000000-0000-0000-0000-000000000866';
      const disposableAccId = '00000000-0000-0000-0000-000000000873';
      const disposableTxId = subject(888);

      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Disposable Transactions WS', 'shared', 'USD', $2)`,
        [disposableWsId, ownerA],
      );
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [disposableMemId, disposableWsId, ownerA],
      );
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
         values ($1, $2, 'Disposable Tx Account', 'cash', 'USD', $3)`,
        [disposableAccId, disposableWsId, ownerA],
      );
      await seedTransaction(
        disposableTxId,
        disposableWsId,
        disposableAccId,
        ownerA,
      );

      const beforeRes = await admin.query(
        'select 1 from public.transactions where id = $1',
        [disposableTxId],
      );
      expect(beforeRes.rows).toHaveLength(1);

      await admin.query('delete from public.workspaces where id = $1', [
        disposableWsId,
      ]);

      const afterRes = await admin.query(
        'select 1 from public.transactions where id = $1',
        [disposableTxId],
      );
      expect(afterRes.rows).toHaveLength(0);
    });

    it('14. Deleting an account referenced by a transaction is REFUSED with 23503 (on delete restrict); after the transaction goes, the same delete succeeds', async () => {
      const txId = subject(889);
      // Same-workspace pairing (account2Id lives in ws2): since
      // transactions_account_workspace_fkey exists, a transaction can only
      // reference an account of its own workspace.
      await seedTransaction(txId, ws2Id, account2Id, ownerB);

      await expect(
        admin.query('delete from public.accounts where id = $1', [account2Id]),
      ).rejects.toMatchObject({ code: '23503' });

      await deleteTransactions([txId]);

      // Positive control: with no referencing transaction left, the restrict
      // FK no longer fires — proving 23503 above came from THIS foreign key.
      await admin.query('delete from public.accounts where id = $1', [
        account2Id,
      ]);
      const gone = await admin.query(
        'select 1 from public.accounts where id = $1',
        [account2Id],
      );
      expect(gone.rows).toHaveLength(0);
    });
  });

  describe('RLS behaviour', () => {
    const visibleTxId = subject(890);

    beforeAll(async () => {
      await seedTransaction(visibleTxId, ws1Id, account1Id, ownerA, {
        description: 'Visible transaction',
      });
    });

    afterAll(async () => {
      await deleteTransactions([visibleTxId]);
    });

    it('15. Positive control: an owner can INSERT through the policy, naming only columns the insert grant covers', async () => {
      let insertedId: string | undefined;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.transactions (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, description, category_id, payee_id, receipt_id, tag_ids, created_by)
             values ($1, $2, 'expense', 'pending', '500', 'EUR', $3, 'Owner positive control', null, null, null, null, $4)
             returning id`,
            [ws1Id, account1Id, '2026-08-24T09:30:00Z', ownerA],
          );
        });
        insertedId = res.rows[0]?.id;
        expect(insertedId).toBeDefined();

        const check = await admin.query(
          'select 1 from public.transactions where id = $1',
          [insertedId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        if (insertedId) await deleteTransactions([insertedId]);
      }
    });

    it('16. A viewer CANNOT insert — refused with 42501 by the POLICY ("new row violates row-level security policy"), NOT by a missing grant; the identical insert by an owner succeeds in the same test', async () => {
      // The attempted insert names ONLY columns covered by the column-scoped
      // insert grant. The owner control below runs the identical statement
      // successfully, so the grant demonstrably covers these columns and the
      // viewer's refusal can only come from the policy's role list.
      const viewerErr = await capturePgError(() =>
        asSubject(viewerE, (client) =>
          client.query(
            `insert into public.transactions (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
             values ($1, $2, 'expense', 'draft', '700', 'USD', $3, $4)`,
            [ws1Id, account1Id, '2026-08-24T10:00:00Z', viewerE],
          ),
        ),
      );
      expect(viewerErr.code).toBe('42501');
      expect(viewerErr.message ?? '').toContain('row-level security policy');
      expect(viewerErr.message ?? '').not.toContain('permission denied');

      const controlRes = await asSubject(ownerA, (client) =>
        client.query(
          `insert into public.transactions (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
           values ($1, $2, 'expense', 'draft', '700', 'USD', $3, $4)
           returning id`,
          [ws1Id, account1Id, '2026-08-24T10:00:00Z', ownerA],
        ),
      );
      const controlId: string | undefined = controlRes.rows[0]?.id;
      expect(controlId).toBeDefined();
      try {
        const check = await admin.query(
          'select 1 from public.transactions where id = $1',
          [controlId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        if (controlId) await deleteTransactions([controlId]);
      }
    });

    it('17. Inserting with created_by bound to a DIFFERENT profile is refused by the policy with 42501 (adapter-supplied attribution is forgeable)', async () => {
      const forgedErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.transactions (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, created_by)
             values ($1, $2, 'income', 'draft', '900', 'USD', $3, $4)`,
            [ws1Id, account1Id, '2026-08-24T10:30:00Z', ownerB],
          ),
        ),
      );
      expect(forgedErr.code).toBe('42501');
      expect(forgedErr.message ?? '').toContain('row-level security policy');
    });

    it('18. An editor CANNOT re-point a transaction to another workspace or another account: both are refused by the COLUMN-SCOPED GRANT ("permission denied", NOT a row-level-security message); has_column_privilege pins the structural fact; positive control: the same editor updates a granted column', async () => {
      const targetId = subject(891);
      try {
        await seedTransaction(targetId, ws1Id, account1Id, ownerA, {
          description: 'Seizable Target',
        });

        const grantRes = await admin.query<{
          ws_updatable: boolean;
          acc_updatable: boolean;
        }>(
          `select has_column_privilege('savia_application', 'public.transactions', 'workspace_id', 'update') as ws_updatable,
                  has_column_privilege('savia_application', 'public.transactions', 'account_id', 'update') as acc_updatable`,
        );
        expect(grantRes.rows[0].ws_updatable).toBe(false);
        expect(grantRes.rows[0].acc_updatable).toBe(false);

        const seizureErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              'update public.transactions set workspace_id = $1 where id = $2',
              [ws2Id, targetId],
            ),
          ),
        );
        expect(seizureErr.code).toBe('42501');
        expect(seizureErr.message ?? '').toContain('permission denied');
        expect(seizureErr.message ?? '').not.toContain(
          'row-level security policy',
        );

        const repointErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              'update public.transactions set account_id = $1 where id = $2',
              [account2Id, targetId],
            ),
          ),
        );
        expect(repointErr.code).toBe('42501');
        expect(repointErr.message ?? '').toContain('permission denied');
        expect(repointErr.message ?? '').not.toContain(
          'row-level security policy',
        );

        const untouched = await admin.query(
          'select workspace_id, account_id from public.transactions where id = $1',
          [targetId],
        );
        expect(untouched.rows[0].workspace_id).toBe(ws1Id);
        expect(untouched.rows[0].account_id).toBe(account1Id);

        // Positive control: the SAME editor CAN update a granted column.
        const editRes = await asSubject(editorD, (client) =>
          client.query(
            'update public.transactions set notes = $1 where id = $2',
            ['Edited By Editor', targetId],
          ),
        );
        expect(editRes.rowCount).toBe(1);
      } finally {
        await deleteTransactions([targetId]);
      }
    });

    it('19. The one-way void transition, BOTH directions pinned: voiding a live row SUCCEEDS (the explicit with check carries no status term), then ANY later update affects ZERO rows', async () => {
      const voidingId = subject(892);
      try {
        await seedTransaction(voidingId, ws1Id, account1Id, ownerA, {
          status: 'confirmed',
          description: 'Voiding Candidate',
        });

        // Pre-control: the row is writable before the void.
        const preRes = await asSubject(editorD, (client) =>
          client.query(
            'update public.transactions set description = $1 where id = $2',
            ['Pre-Void Edit', voidingId],
          ),
        );
        expect(preRes.rowCount).toBe(1);

        // Direction 1: the void itself REACHES the row and passes with check.
        // If the update policy reused its using expression as the with-check
        // (no explicit with check declared), this statement would raise 42501
        // because the NEW row's status IS 'voided' — voiding would be
        // unreachable. It must affect exactly one row instead.
        const voidRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.transactions
                set status = 'voided', voided_at = now(), updated_at = now(), version = version + 1
              where id = $1`,
            [voidingId],
          ),
        );
        expect(voidRes.rowCount).toBe(1);

        const storedAfterVoid = await admin.query(
          'select status, voided_at from public.transactions where id = $1',
          [voidingId],
        );
        expect(storedAfterVoid.rows[0].status).toBe('voided');
        expect(storedAfterVoid.rows[0].voided_at).not.toBeNull();

        // Direction 2: once voided, `using` filters the row out of every later
        // statement — updates by editor, administrator AND owner all hit ZERO
        // rows, including an un-void attempt.
        const postEditorRes = await asSubject(editorD, (client) =>
          client.query(
            'update public.transactions set description = $1 where id = $2',
            ['Mutated While Voided', voidingId],
          ),
        );
        expect(postEditorRes.rowCount).toBe(0);

        const postUnvoidRes = await asSubject(adminC, (client) =>
          client.query(
            `update public.transactions
                set status = 'confirmed', voided_at = null, updated_at = now(), version = version + 1
              where id = $1`,
            [voidingId],
          ),
        );
        expect(postUnvoidRes.rowCount).toBe(0);

        const postOwnerRes = await asSubject(ownerA, (client) =>
          client.query(
            'update public.transactions set notes = $1 where id = $2',
            ['Mutated While Voided By Owner', voidingId],
          ),
        );
        expect(postOwnerRes.rowCount).toBe(0);

        // Stored values are untouched by every post-void attempt.
        const stored = await admin.query(
          'select status, description, voided_at from public.transactions where id = $1',
          [voidingId],
        );
        expect(stored.rows[0].status).toBe('voided');
        expect(stored.rows[0].description).toBe('Pre-Void Edit');
        expect(stored.rows[0].voided_at).not.toBeNull();
      } finally {
        await deleteTransactions([voidingId]);
      }
    });

    it('20. An owner reads workspace transactions, a viewer reads them too, an outsider reads none', async () => {
      const ownerRes = await asSubject(ownerA, (client) =>
        client.query(
          'select id from public.transactions where workspace_id = $1',
          [ws1Id],
        ),
      );
      expect(ownerRes.rows.map((r) => r.id)).toContain(visibleTxId);

      const viewerRes = await asSubject(viewerE, (client) =>
        client.query(
          'select id from public.transactions where workspace_id = $1',
          [ws1Id],
        ),
      );
      expect(viewerRes.rows.map((r) => r.id)).toContain(visibleTxId);

      const outsiderRes = await asSubject(outsiderZ, (client) =>
        client.query(
          'select id from public.transactions where workspace_id = $1',
          [ws1Id],
        ),
      );
      expect(outsiderRes.rows).toHaveLength(0);
    });

    it('21. No delete is possible, BY GRANT: DELETE raises 42501 with a permission-denied message, not a row-level-security one', async () => {
      const delErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query('delete from public.transactions where id = $1', [
            visibleTxId,
          ]),
        ),
      );
      expect(delErr.code).toBe('42501');
      expect(delErr.message ?? '').toContain('permission denied');
      expect(delErr.message ?? '').not.toContain('row-level security policy');

      const stillThere = await admin.query(
        'select 1 from public.transactions where id = $1',
        [visibleTxId],
      );
      expect(stillThere.rows).toHaveLength(1);
    });
  });

  describe('Cross-workspace account binding (202608240004_transaction_account_workspace_binding.sql)', () => {
    // Disposable fixtures, isolated from the shared ones above: test 14
    // already deleted account2Id by the time these run.
    const bindAttackWsId = '00000000-0000-0000-0000-000000000854';
    const bindVictimWsId = '00000000-0000-0000-0000-000000000855';
    const bindAccAttackId = '00000000-0000-0000-0000-000000000874';
    const bindAccVictimId = '00000000-0000-0000-0000-000000000875';

    beforeAll(async () => {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Binding Attack WS', 'shared', 'USD', $2),
                ($3, 'Binding Victim WS', 'shared', 'USD', $4)`,
        [bindAttackWsId, ownerA, bindVictimWsId, ownerB],
      );
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
         values ($1, $2, 'Binding Attack Account', 'cash', 'USD', $3),
                ($4, $5, 'Binding Victim Account', 'cash', 'USD', $6)`,
        [
          bindAccAttackId,
          bindAttackWsId,
          ownerA,
          bindAccVictimId,
          bindVictimWsId,
          ownerB,
        ],
      );
    });

    afterAll(async () => {
      // Defensive isolation: if the binding ever regresses, a poisoned
      // cross-workspace row left behind by test 22 must not brick this
      // cleanup with 23503 the same way it bricks production deletes.
      await admin.query(
        'delete from public.transactions where workspace_id = any($1::uuid[])',
        [[bindAttackWsId, bindVictimWsId]],
      );
      // Workspace deletes cascade accounts and any surviving transactions
      // away; the victim workspace may already be gone (test 24).
      await admin.query(
        'delete from public.workspaces where id = any($1::uuid[])',
        [[bindAttackWsId, bindVictimWsId]],
      );
    });

    it('22. Inserting a transaction whose account belongs to a DIFFERENT workspace is refused with 23503 naming transactions_account_workspace_fkey — superuser path, so neither RLS nor grants can be the refuser', async () => {
      // The approved superuser-isolation technique: this insert runs as
      // superuser, bypassing RLS and every grant, so the ONLY mechanism that
      // can refuse it is the foreign key. The old single-column
      // `references public.accounts(id)` FK ACCEPTED this insert (RI checks
      // bypass row security), which is exactly the defect being fixed.
      const crossErr = await capturePgError(() =>
        seedTransaction(subject(893), bindAttackWsId, bindAccVictimId, ownerA),
      );
      expect(crossErr.code).toBe('23503');
      expect(crossErr.message ?? '').toContain(
        'violates foreign key constraint',
      );
      // Pin the CONCRETE constraint name, not just the message family.
      expect(crossErr.message ?? '').toContain(
        'transactions_account_workspace_fkey',
      );
      expect(crossErr.message ?? '').not.toContain('row-level security');
      expect(crossErr.message ?? '').not.toContain('permission denied');

      // Structural pin: exactly one FK on transactions carries the composite
      // shape and restrict action, so a future revert cannot pass silently.
      const fkRes = await admin.query<{ def: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as def, confdeltype
           from pg_constraint
          where conrelid = 'public.transactions'::regclass
            and conname = 'transactions_account_workspace_fkey'`,
      );
      expect(fkRes.rows).toHaveLength(1);
      expect(fkRes.rows[0].def).toMatch(
        /foreign key \(workspace_id, account_id\) references accounts\(workspace_id, id\) on delete restrict/i,
      );
      expect(fkRes.rows[0].confdeltype).toBe('r');
    });

    it('23. Positive control on the identical superuser path: the same insert with a SAME-WORKSPACE account succeeds', async () => {
      // Without this control, a binding constraint that refuses EVERYTHING
      // would still pass test 22.
      const controlId = subject(894);
      try {
        await seedTransaction(
          controlId,
          bindAttackWsId,
          bindAccAttackId,
          ownerA,
        );
        const check = await admin.query(
          'select 1 from public.transactions where id = $1',
          [controlId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        await deleteTransactions([controlId]);
      }
    });

    it('24. REGRESSION (the DoS this binding removes): deleting a workspace holding an account referenced by its OWN transaction SUCCEEDS — both rows die together in the cascade', async () => {
      // Before the fix this shape was safe only by convention: the poison was
      // a CROSS-workspace reference. After it, every reference is necessarily
      // same-workspace, so this must keep working — if it broke, the fix
      // would have RELOCATED the DoS instead of removing it.
      const dosTxId = subject(895);
      // Defensive isolation: purge anything earlier tests may have left in
      // these fixtures (a poison row from a refused-refusal state would
      // otherwise fail THIS delete for reasons this test does not own), so
      // the assertion below is exclusively about same-workspace references.
      await admin.query(
        'delete from public.transactions where workspace_id = any($1::uuid[])',
        [[bindAttackWsId, bindVictimWsId]],
      );
      await seedTransaction(dosTxId, bindVictimWsId, bindAccVictimId, ownerB);

      const beforeRes = await admin.query(
        'select 1 from public.transactions where id = $1',
        [dosTxId],
      );
      expect(beforeRes.rows).toHaveLength(1);

      await admin.query('delete from public.workspaces where id = $1', [
        bindVictimWsId,
      ]);

      const txGoneRes = await admin.query(
        'select 1 from public.transactions where id = $1',
        [dosTxId],
      );
      expect(txGoneRes.rows).toHaveLength(0);

      const accGoneRes = await admin.query(
        'select 1 from public.accounts where id = $1',
        [bindAccVictimId],
      );
      expect(accGoneRes.rows).toHaveLength(0);
    });
  });

  describe('Cross-workspace category and payee catalog bindings (202608290005_transaction_catalog_bindings.sql)', () => {
    const catWs1Id = '00000000-0000-0000-0000-000000000856';
    const catWs2Id = '00000000-0000-0000-0000-000000000857';
    const catAcc1Id = '00000000-0000-0000-0000-000000000876';
    const catAcc2Id = '00000000-0000-0000-0000-000000000877';
    const catWs1CategoryId = '00000000-0000-0000-0000-000000000831';
    const catWs2CategoryId = '00000000-0000-0000-0000-000000000832';
    const catWs1PayeeId = '00000000-0000-0000-0000-000000000841';
    const catWs2PayeeId = '00000000-0000-0000-0000-000000000842';
    const absentCategoryId = '00000000-0000-0000-0000-000000000839';
    const absentPayeeId = '00000000-0000-0000-0000-000000000849';

    const memCatWs1OwnerAId = '00000000-0000-0000-0000-000000000867';
    const memCatWs1EditorDId = '00000000-0000-0000-0000-000000000868';
    const memCatWs2OwnerBId = '00000000-0000-0000-0000-000000000869';

    beforeAll(async () => {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Catalog Binding WS 1', 'shared', 'USD', $2),
                ($3, 'Catalog Binding WS 2', 'shared', 'USD', $4)`,
        [catWs1Id, ownerA, catWs2Id, ownerB],
      );
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active'),
                ($4, $5, $6, 'editor', 'active'),
                ($7, $8, $9, 'owner', 'active')`,
        [
          memCatWs1OwnerAId,
          catWs1Id,
          ownerA,
          memCatWs1EditorDId,
          catWs1Id,
          editorD,
          memCatWs2OwnerBId,
          catWs2Id,
          ownerB,
        ],
      );
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
         values ($1, $2, 'Catalog Acc 1', 'cash', 'USD', $3),
                ($4, $5, 'Catalog Acc 2', 'cash', 'USD', $6)`,
        [catAcc1Id, catWs1Id, ownerA, catAcc2Id, catWs2Id, ownerB],
      );
      await admin.query(
        `insert into public.categories (id, workspace_id, name, kind, created_by)
         values ($1, $2, 'Groceries WS1', 'expense', $3),
                ($4, $5, 'Groceries WS2', 'expense', $6)`,
        [
          catWs1CategoryId,
          catWs1Id,
          ownerA,
          catWs2CategoryId,
          catWs2Id,
          ownerB,
        ],
      );
      await admin.query(
        `insert into public.payees (id, workspace_id, name, created_by)
         values ($1, $2, 'Supermarket WS1', $3),
                ($4, $5, 'Supermarket WS2', $6)`,
        [catWs1PayeeId, catWs1Id, ownerA, catWs2PayeeId, catWs2Id, ownerB],
      );
    });

    afterAll(async () => {
      await admin.query(
        'delete from public.transactions where workspace_id = any($1::uuid[])',
        [[catWs1Id, catWs2Id]],
      );
      await admin.query(
        'delete from public.categories where workspace_id = any($1::uuid[])',
        [[catWs1Id, catWs2Id]],
      );
      await admin.query(
        'delete from public.payees where workspace_id = any($1::uuid[])',
        [[catWs1Id, catWs2Id]],
      );
      await admin.query(
        'delete from public.workspaces where id = any($1::uuid[])',
        [[catWs1Id, catWs2Id]],
      );
    });

    it('25. payees_workspace_id_id_key exists as a composite unique constraint on public.payees (workspace_id, id)', async () => {
      const uqRes = await admin.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.payees'::regclass
            and conname = 'payees_workspace_id_id_key'
            and contype = 'u'`,
      );
      expect(uqRes.rows).toHaveLength(1);
      expect(uqRes.rows[0].def).toMatch(/unique \(workspace_id, id\)/i);
    });

    it('26. Structural pins: transactions_category_workspace_fkey and transactions_payee_workspace_fkey exist as composite foreign keys with ON DELETE RESTRICT', async () => {
      const catFkRes = await admin.query<{ def: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as def, confdeltype
           from pg_constraint
          where conrelid = 'public.transactions'::regclass
            and conname = 'transactions_category_workspace_fkey'
            and contype = 'f'`,
      );
      expect(catFkRes.rows).toHaveLength(1);
      expect(catFkRes.rows[0].def).toMatch(
        /foreign key \(workspace_id, category_id\) references categories\(workspace_id, id\) on delete restrict/i,
      );
      expect(catFkRes.rows[0].confdeltype).toBe('r');

      const payeeFkRes = await admin.query<{
        def: string;
        confdeltype: string;
      }>(
        `select pg_get_constraintdef(oid) as def, confdeltype
           from pg_constraint
          where conrelid = 'public.transactions'::regclass
            and conname = 'transactions_payee_workspace_fkey'
            and contype = 'f'`,
      );
      expect(payeeFkRes.rows).toHaveLength(1);
      expect(payeeFkRes.rows[0].def).toMatch(
        /foreign key \(workspace_id, payee_id\) references payees\(workspace_id, id\) on delete restrict/i,
      );
      expect(payeeFkRes.rows[0].confdeltype).toBe('r');
    });

    it('26b. Structural pins: transactions_workspace_category_idx and transactions_workspace_payee_idx exist as partial indexes on (workspace_id, category_id) and (workspace_id, payee_id)', async () => {
      const catRes = await admin.query<{
        colnames: string[];
        predicate: string;
      }>(
        `select array_agg(a.attname::text order by k.ord) as colnames,
                pg_get_expr(i.indpred, i.indrelid) as predicate
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'transactions_workspace_category_idx'
            and i.indrelid = 'public.transactions'::regclass
            and i.indisunique = false
          group by i.indpred, i.indrelid`,
      );
      expect(catRes.rows).toHaveLength(1);
      expect(catRes.rows[0].colnames).toEqual(['workspace_id', 'category_id']);
      expect(catRes.rows[0].predicate).toMatch(/category_id IS NOT NULL/i);

      const payeeRes = await admin.query<{
        colnames: string[];
        predicate: string;
      }>(
        `select array_agg(a.attname::text order by k.ord) as colnames,
                pg_get_expr(i.indpred, i.indrelid) as predicate
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'transactions_workspace_payee_idx'
            and i.indrelid = 'public.transactions'::regclass
            and i.indisunique = false
          group by i.indpred, i.indrelid`,
      );
      expect(payeeRes.rows).toHaveLength(1);
      expect(payeeRes.rows[0].colnames).toEqual(['workspace_id', 'payee_id']);
      expect(payeeRes.rows[0].predicate).toMatch(/payee_id IS NOT NULL/i);
    });

    it('27. Inserting a transaction with a category_id from ANOTHER workspace is refused with 23503 naming transactions_category_workspace_fkey — tested under savia_application and superuser; NO row created', async () => {
      const crossCatTxId = subject(896);
      const appErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.transactions
               (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, created_by)
             values ($1, $2, 'expense', 'confirmed', 1000, 'USD', now(), $3, $4)`,
            [catWs1Id, catAcc1Id, catWs2CategoryId, ownerA],
          ),
        ),
      );
      expect(appErr.code).toBe('23503');
      expect(appErr.message ?? '').toContain(
        'transactions_category_workspace_fkey',
      );

      const superErr = await capturePgError(() =>
        seedTransaction(crossCatTxId, catWs1Id, catAcc1Id, ownerA, {
          categoryId: catWs2CategoryId,
        }),
      );
      expect(superErr.code).toBe('23503');
      expect(superErr.message ?? '').toContain(
        'transactions_category_workspace_fkey',
      );

      const check = await admin.query(
        'select 1 from public.transactions where id = $1',
        [crossCatTxId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('28. Updating an existing transaction category_id to a category from ANOTHER workspace is refused with 23503 naming transactions_category_workspace_fkey under savia_application role', async () => {
      const txId = subject(897);
      try {
        await seedTransaction(txId, catWs1Id, catAcc1Id, ownerA, {
          categoryId: catWs1CategoryId,
        });

        const updateErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              `update public.transactions
                  set category_id = $1, updated_at = now(), version = version + 1
                where id = $2`,
              [catWs2CategoryId, txId],
            ),
          ),
        );
        expect(updateErr.code).toBe('23503');
        expect(updateErr.message ?? '').toContain(
          'transactions_category_workspace_fkey',
        );

        const stored = await admin.query<{ category_id: string }>(
          'select category_id from public.transactions where id = $1',
          [txId],
        );
        expect(stored.rows[0].category_id).toBe(catWs1CategoryId);
      } finally {
        await deleteTransactions([txId]);
      }
    });

    it('29. Inserting a transaction with a payee_id from ANOTHER workspace is refused with 23503 naming transactions_payee_workspace_fkey; NO row created', async () => {
      const crossPayeeTxId = subject(898);
      const appErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.transactions
               (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, payee_id, created_by)
             values ($1, $2, 'expense', 'confirmed', 1000, 'USD', now(), $3, $4)`,
            [catWs1Id, catAcc1Id, catWs2PayeeId, ownerA],
          ),
        ),
      );
      expect(appErr.code).toBe('23503');
      expect(appErr.message ?? '').toContain(
        'transactions_payee_workspace_fkey',
      );

      const superErr = await capturePgError(() =>
        seedTransaction(crossPayeeTxId, catWs1Id, catAcc1Id, ownerA, {
          payeeId: catWs2PayeeId,
        }),
      );
      expect(superErr.code).toBe('23503');
      expect(superErr.message ?? '').toContain(
        'transactions_payee_workspace_fkey',
      );

      const check = await admin.query(
        'select 1 from public.transactions where id = $1',
        [crossPayeeTxId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('30. Updating an existing transaction payee_id to a payee from ANOTHER workspace is refused with 23503 naming transactions_payee_workspace_fkey under savia_application role', async () => {
      const txId = subject(899);
      try {
        await seedTransaction(txId, catWs1Id, catAcc1Id, ownerA, {
          payeeId: catWs1PayeeId,
        });

        const updateErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              `update public.transactions
                  set payee_id = $1, updated_at = now(), version = version + 1
                where id = $2`,
              [catWs2PayeeId, txId],
            ),
          ),
        );
        expect(updateErr.code).toBe('23503');
        expect(updateErr.message ?? '').toContain(
          'transactions_payee_workspace_fkey',
        );

        const stored = await admin.query<{ payee_id: string }>(
          'select payee_id from public.transactions where id = $1',
          [txId],
        );
        expect(stored.rows[0].payee_id).toBe(catWs1PayeeId);
      } finally {
        await deleteTransactions([txId]);
      }
    });

    it('31. Inserting or updating a transaction with a nonexistent category_id is refused with 23503 naming transactions_category_workspace_fkey', async () => {
      const absentCatTxId = subject(911);
      const insertErr = await capturePgError(() =>
        seedTransaction(absentCatTxId, catWs1Id, catAcc1Id, ownerA, {
          categoryId: absentCategoryId,
        }),
      );
      expect(insertErr.code).toBe('23503');
      expect(insertErr.message ?? '').toContain(
        'transactions_category_workspace_fkey',
      );

      const liveTxId = subject(912);
      try {
        await seedTransaction(liveTxId, catWs1Id, catAcc1Id, ownerA, {
          categoryId: catWs1CategoryId,
        });

        const updateErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.transactions
                  set category_id = $1, updated_at = now(), version = version + 1
                where id = $2`,
              [absentCategoryId, liveTxId],
            ),
          ),
        );
        expect(updateErr.code).toBe('23503');
        expect(updateErr.message ?? '').toContain(
          'transactions_category_workspace_fkey',
        );
      } finally {
        await deleteTransactions([liveTxId]);
      }
    });

    it('32. Inserting or updating a transaction with a nonexistent payee_id is refused with 23503 naming transactions_payee_workspace_fkey', async () => {
      const absentPayeeTxId = subject(913);
      const insertErr = await capturePgError(() =>
        seedTransaction(absentPayeeTxId, catWs1Id, catAcc1Id, ownerA, {
          payeeId: absentPayeeId,
        }),
      );
      expect(insertErr.code).toBe('23503');
      expect(insertErr.message ?? '').toContain(
        'transactions_payee_workspace_fkey',
      );

      const liveTxId = subject(914);
      try {
        await seedTransaction(liveTxId, catWs1Id, catAcc1Id, ownerA, {
          payeeId: catWs1PayeeId,
        });

        const updateErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.transactions
                  set payee_id = $1, updated_at = now(), version = version + 1
                where id = $2`,
              [absentPayeeId, liveTxId],
            ),
          ),
        );
        expect(updateErr.code).toBe('23503');
        expect(updateErr.message ?? '').toContain(
          'transactions_payee_workspace_fkey',
        );
      } finally {
        await deleteTransactions([liveTxId]);
      }
    });

    it('33. Inserting and reading a transaction with BOTH category_id and payee_id null succeeds (MATCH SIMPLE nullable composite FK)', async () => {
      let insertedId: string | undefined;
      try {
        const insertRes = await asSubject(ownerA, (client) =>
          client.query(
            `insert into public.transactions
               (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, payee_id, created_by)
             values ($1, $2, 'income', 'confirmed', 2500, 'USD', now(), null, null, $3)
             returning id, category_id, payee_id`,
            [catWs1Id, catAcc1Id, ownerA],
          ),
        );
        insertedId = insertRes.rows[0]?.id;
        expect(insertedId).toBeDefined();
        expect(insertRes.rows[0].category_id).toBeNull();
        expect(insertRes.rows[0].payee_id).toBeNull();

        const stored = await admin.query<{
          category_id: string | null;
          payee_id: string | null;
        }>(
          'select category_id, payee_id from public.transactions where id = $1',
          [insertedId],
        );
        expect(stored.rows[0].category_id).toBeNull();
        expect(stored.rows[0].payee_id).toBeNull();
      } finally {
        if (insertedId) await deleteTransactions([insertedId]);
      }
    });

    it('34. Inserting and reading a transaction with legitimate same-workspace category_id and payee_id succeeds as savia_application', async () => {
      let insertedId: string | undefined;
      try {
        const insertRes = await asSubject(ownerA, (client) =>
          client.query(
            `insert into public.transactions
               (workspace_id, account_id, type, status, amount_minor, currency, occurred_at, category_id, payee_id, created_by)
             values ($1, $2, 'expense', 'confirmed', 3500, 'USD', now(), $3, $4, $5)
             returning id, category_id, payee_id`,
            [catWs1Id, catAcc1Id, catWs1CategoryId, catWs1PayeeId, ownerA],
          ),
        );
        insertedId = insertRes.rows[0]?.id;
        expect(insertedId).toBeDefined();
        expect(insertRes.rows[0].category_id).toBe(catWs1CategoryId);
        expect(insertRes.rows[0].payee_id).toBe(catWs1PayeeId);

        const readRes = await asSubject(editorD, (client) =>
          client.query<{ category_id: string; payee_id: string }>(
            'select category_id, payee_id from public.transactions where id = $1',
            [insertedId],
          ),
        );
        expect(readRes.rows[0].category_id).toBe(catWs1CategoryId);
        expect(readRes.rows[0].payee_id).toBe(catWs1PayeeId);
      } finally {
        if (insertedId) await deleteTransactions([insertedId]);
      }
    });

    it('35. Updating an existing transaction to legitimate same-workspace category_id and payee_id, and back to null, succeeds under savia_application', async () => {
      const mutTxId = subject(917);
      try {
        await seedTransaction(mutTxId, catWs1Id, catAcc1Id, ownerA, {
          categoryId: null,
          payeeId: null,
        });

        // 1. Update from null to populated
        const popRes = await asSubject(editorD, (client) =>
          client.query(
            `update public.transactions
                set category_id = $1, payee_id = $2, updated_at = now(), version = version + 1
              where id = $3`,
            [catWs1CategoryId, catWs1PayeeId, mutTxId],
          ),
        );
        expect(popRes.rowCount).toBe(1);

        const storedPop = await admin.query<{
          category_id: string;
          payee_id: string;
        }>(
          'select category_id, payee_id from public.transactions where id = $1',
          [mutTxId],
        );
        expect(storedPop.rows[0].category_id).toBe(catWs1CategoryId);
        expect(storedPop.rows[0].payee_id).toBe(catWs1PayeeId);

        // 2. Update from populated back to null
        const nullRes = await asSubject(editorD, (client) =>
          client.query(
            `update public.transactions
                set category_id = null, payee_id = null, updated_at = now(), version = version + 1
              where id = $1`,
            [mutTxId],
          ),
        );
        expect(nullRes.rowCount).toBe(1);

        const storedNull = await admin.query<{
          category_id: string | null;
          payee_id: string | null;
        }>(
          'select category_id, payee_id from public.transactions where id = $1',
          [mutTxId],
        );
        expect(storedNull.rows[0].category_id).toBeNull();
        expect(storedNull.rows[0].payee_id).toBeNull();
      } finally {
        await deleteTransactions([mutTxId]);
      }
    });

    it('36. Deleting a category referenced by a transaction is REFUSED with 23503 (ON DELETE RESTRICT); succeeds once the transaction is removed', async () => {
      const dispCatId = '00000000-0000-0000-0000-000000000833';
      await admin.query(
        `insert into public.categories (id, workspace_id, name, kind, created_by)
         values ($1, $2, 'Disposable Category', 'expense', $3)`,
        [dispCatId, catWs1Id, ownerA],
      );

      const refTxId = subject(918);
      try {
        await seedTransaction(refTxId, catWs1Id, catAcc1Id, ownerA, {
          categoryId: dispCatId,
        });

        await expect(
          admin.query('delete from public.categories where id = $1', [
            dispCatId,
          ]),
        ).rejects.toMatchObject({ code: '23503' });

        await deleteTransactions([refTxId]);

        // Positive control: now the delete succeeds
        await admin.query('delete from public.categories where id = $1', [
          dispCatId,
        ]);
        const gone = await admin.query(
          'select 1 from public.categories where id = $1',
          [dispCatId],
        );
        expect(gone.rows).toHaveLength(0);
      } finally {
        await deleteTransactions([refTxId]);
        await admin.query('delete from public.categories where id = $1', [
          dispCatId,
        ]);
      }
    });

    it('37. Deleting a payee referenced by a transaction is REFUSED with 23503 (ON DELETE RESTRICT); succeeds once the transaction is removed', async () => {
      const dispPayeeId = '00000000-0000-0000-0000-000000000843';
      await admin.query(
        `insert into public.payees (id, workspace_id, name, created_by)
         values ($1, $2, 'Disposable Payee', $3)`,
        [dispPayeeId, catWs1Id, ownerA],
      );

      const refTxId = subject(919);
      try {
        await seedTransaction(refTxId, catWs1Id, catAcc1Id, ownerA, {
          payeeId: dispPayeeId,
        });

        await expect(
          admin.query('delete from public.payees where id = $1', [dispPayeeId]),
        ).rejects.toMatchObject({ code: '23503' });

        await deleteTransactions([refTxId]);

        // Positive control: now the delete succeeds
        await admin.query('delete from public.payees where id = $1', [
          dispPayeeId,
        ]);
        const gone = await admin.query(
          'select 1 from public.payees where id = $1',
          [dispPayeeId],
        );
        expect(gone.rows).toHaveLength(0);
      } finally {
        await deleteTransactions([refTxId]);
        await admin.query('delete from public.payees where id = $1', [
          dispPayeeId,
        ]);
      }
    });
  });
});
