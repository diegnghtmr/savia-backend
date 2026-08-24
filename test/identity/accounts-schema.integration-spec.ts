// Migrations under test: 202608240002_account_tables.sql
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

describe('Workspace accounts schema, constraints, RLS, and grants (202608240002_account_tables.sql)', () => {
  let admin: Pool;

  const ownerA = subject(901);
  const adminC = subject(902);
  const editorD = subject(903);
  const viewerE = subject(904);
  const outsiderZ = subject(905);
  const ownerB = subject(906);

  const ws1Id = '00000000-0000-0000-0000-000000000951';
  const ws2Id = '00000000-0000-0000-0000-000000000952';

  const memOwnerAId = '00000000-0000-0000-0000-000000000961';
  const memAdminCId = '00000000-0000-0000-0000-000000000962';
  const memEditorDId = '00000000-0000-0000-0000-000000000963';
  const memViewerEId = '00000000-0000-0000-0000-000000000964';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000000965';

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

  async function seedAccount(
    id: string,
    workspaceId: string,
    createdBy: string,
    overrides: {
      name?: string;
      type?: string;
      currency?: string;
      status?: string;
      closedAt?: string | null;
    } = {},
  ): Promise<void> {
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, closed_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        workspaceId,
        overrides.name ?? 'Seeded Account',
        overrides.type ?? 'cash',
        overrides.currency ?? 'USD',
        overrides.status ?? 'active',
        overrides.closedAt ?? null,
        createdBy,
      ],
    );
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
        'owner-a@example.test',
        adminC,
        'admin-c@example.test',
        editorD,
        'editor-d@example.test',
        viewerE,
        'viewer-e@example.test',
        outsiderZ,
        'outsider-z@example.test',
        ownerB,
        'owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'owner-a@example.test', 'Owner A'],
      [adminC, 'admin-c@example.test', 'Admin C'],
      [editorD, 'editor-d@example.test', 'Editor D'],
      [viewerE, 'viewer-e@example.test', 'Viewer E'],
      [outsiderZ, 'outsider-z@example.test', 'Outsider Z'],
      [ownerB, 'owner-b@example.test', 'Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Accounts Shared Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Accounts Shared Workspace 2', 'shared', 'USD', null, $4)`,
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
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe('Structure and ACL', () => {
    it('1. The fitness:financial tag is present and apostrophe-free on BOTH public.accounts and public.command_idempotency_records', async () => {
      const res = await admin.query<{
        table_name: string;
        description: string | null;
      }>(
        `select 'accounts' as table_name, obj_description('public.accounts'::regclass) as description
         union all
         select 'command_idempotency_records' as table_name, obj_description('public.command_idempotency_records'::regclass) as description`,
      );

      const byTable = new Map(
        res.rows.map((r) => [r.table_name, r.description]),
      );

      const accountsDescription = byTable.get('accounts');
      expect(accountsDescription).not.toBeNull();
      expect(accountsDescription).toContain('fitness:financial');
      // An apostrophe inside the comment text makes
      // scripts/verify-financial-tables.mjs stop matching the tag (its regex
      // captures up to the first quote character), so the table silently
      // escapes the workspace_id rule. Pin the text itself.
      expect(accountsDescription).not.toContain("'");

      const idempotencyDescription = byTable.get('command_idempotency_records');
      expect(idempotencyDescription).not.toBeNull();
      expect(idempotencyDescription).toContain('fitness:financial');
      expect(idempotencyDescription).not.toContain("'");
    });

    it('2. public.accounts has relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
         from pg_class
         where oid = 'public.accounts'::regclass`,
      );
      expect(rlsRes.rows[0].relrowsecurity).toBe(true);
      expect(rlsRes.rows[0].relforcerowsecurity).toBe(true);
    });

    it('3. savia_application holds SELECT on every column, INSERT on exactly (created_by, currency, description, include_in_net_worth, institution, masked_number, name, type, workspace_id), UPDATE on exactly (closed_at, color_token, description, icon, include_in_net_worth, institution, masked_number, name, status, updated_at, version)', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.accounts', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.accounts', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.accounts', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'accounts'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'closed_at',
        'color_token',
        'created_at',
        'created_by',
        'currency',
        'description',
        'icon',
        'id',
        'include_in_net_worth',
        'institution',
        'masked_number',
        'name',
        'status',
        'type',
        'updated_at',
        'version',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'created_by',
        'currency',
        'description',
        'include_in_net_worth',
        'institution',
        'masked_number',
        'name',
        'type',
        'workspace_id',
      ]);

      // workspace_id is deliberately ABSENT here: a table-wide update grant
      // would let a write path re-point an account into another workspace and
      // seize it (202607150011:10-14, 202607150014:58-59).
      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([
        'closed_at',
        'color_token',
        'description',
        'icon',
        'include_in_net_worth',
        'institution',
        'masked_number',
        'name',
        'status',
        'updated_at',
        'version',
      ]);
    });

    it('4. There is NO balance column, cached or otherwise — asserted positively via information_schema.columns', async () => {
      const absenceRes = await admin.query<{ balance_columns: number }>(
        `select count(*)::int as balance_columns
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'accounts'
            and column_name ilike '%balance%'`,
      );
      expect(absenceRes.rows[0].balance_columns).toBe(0);

      // And the complete column inventory is pinned, so ANY added column (a
      // balance under another name included) fails this test too.
      const inventoryRes = await admin.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'accounts'
          order by column_name`,
      );
      expect(inventoryRes.rows.map((r) => r.column_name)).toEqual([
        'closed_at',
        'color_token',
        'created_at',
        'created_by',
        'currency',
        'description',
        'icon',
        'id',
        'include_in_net_worth',
        'institution',
        'masked_number',
        'name',
        'status',
        'type',
        'updated_at',
        'version',
        'workspace_id',
      ]);
    });

    it('5. savia_application holds NO delete privilege on public.accounts (accounts are closed, never deleted)', async () => {
      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.accounts', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);
    });

    it('6. The keyset pagination index exists on exactly (workspace_id, created_at, id)', async () => {
      const res = await admin.query<{ colnames: string[] }>(
        `select array_agg(a.attname::text order by k.ord) as colnames
           from pg_index i
           join pg_class idx on idx.oid = i.indexrelid
           join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where idx.relname = 'accounts_workspace_keyset_idx'
            and i.indisunique = false`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].colnames).toEqual([
        'workspace_id',
        'created_at',
        'id',
      ]);
    });
  });

  describe('Constraints', () => {
    it("7. The currency check refuses 'usd' and 'US' with 23514; positive control: 'USD' is accepted", async () => {
      const lowerErr = await capturePgError(() =>
        seedAccount(subject(971), ws1Id, ownerA, { currency: 'usd' }),
      );
      expect(lowerErr.code).toBe('23514');

      const shortErr = await capturePgError(() =>
        seedAccount(subject(971), ws1Id, ownerA, { currency: 'US' }),
      );
      expect(shortErr.code).toBe('23514');

      const okId = subject(971);
      try {
        await seedAccount(okId, ws1Id, ownerA, { currency: 'USD' });
        const check = await admin.query(
          'select 1 from public.accounts where id = $1',
          [okId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        await deleteAccount(okId);
      }
    });

    it('8. check ((status = closed) = (closed_at is not null)) refuses BOTH directions: a closed account with null closed_at and an active account with a set closed_at, each with 23514; positive controls accept both valid shapes', async () => {
      const closedNullErr = await capturePgError(() =>
        seedAccount(subject(972), ws1Id, ownerA, {
          status: 'closed',
          closedAt: null,
        }),
      );
      expect(closedNullErr.code).toBe('23514');

      const activeSetErr = await capturePgError(() =>
        seedAccount(subject(972), ws1Id, ownerA, {
          status: 'active',
          closedAt: new Date().toISOString(),
        }),
      );
      expect(activeSetErr.code).toBe('23514');

      const closedOkId = subject(972);
      const activeOkId = subject(973);
      try {
        await seedAccount(closedOkId, ws1Id, ownerA, {
          status: 'closed',
          closedAt: new Date().toISOString(),
        });
        await seedAccount(activeOkId, ws1Id, ownerA, {
          status: 'active',
          closedAt: null,
        });
        const check = await admin.query(
          'select id, status, closed_at from public.accounts where id in ($1, $2)',
          [closedOkId, activeOkId],
        );
        expect(check.rows).toHaveLength(2);
      } finally {
        await admin.query(
          'delete from public.accounts where id = any($1::uuid[])',
          [[closedOkId, activeOkId]],
        );
      }
    });

    it('9. Two accounts with the same name in one workspace coexist (no unique constraint on name)', async () => {
      const firstId = subject(974);
      const secondId = subject(975);
      try {
        await seedAccount(firstId, ws1Id, ownerA, { name: 'Duplicate Name' });
        await seedAccount(secondId, ws1Id, ownerA, { name: 'Duplicate Name' });
        const check = await admin.query(
          `select count(*)::int as n from public.accounts where workspace_id = $1 and name = 'Duplicate Name'`,
          [ws1Id],
        );
        expect(check.rows[0].n).toBe(2);
      } finally {
        await admin.query(
          'delete from public.accounts where id = any($1::uuid[])',
          [[firstId, secondId]],
        );
      }
    });

    it('10. Deleting a workspace cascades its accounts away', async () => {
      const disposableWsId = '00000000-0000-0000-0000-000000000953';
      const disposableMemId = '00000000-0000-0000-0000-000000000966';
      const disposableAccId = subject(976);

      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Disposable Accounts WS', 'shared', 'USD', $2)`,
        [disposableWsId, ownerA],
      );
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [disposableMemId, disposableWsId, ownerA],
      );
      await seedAccount(disposableAccId, disposableWsId, ownerA);

      const beforeRes = await admin.query(
        'select 1 from public.accounts where id = $1',
        [disposableAccId],
      );
      expect(beforeRes.rows).toHaveLength(1);

      await admin.query('delete from public.workspaces where id = $1', [
        disposableWsId,
      ]);

      const afterRes = await admin.query(
        'select 1 from public.accounts where id = $1',
        [disposableAccId],
      );
      expect(afterRes.rows).toHaveLength(0);
    });

    it('11. Deleting a profile referenced by created_by is REFUSED with 23503, proving on delete restrict', async () => {
      const disposableProfileId = subject(907);
      await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [
        disposableProfileId,
        'disposable-account-creator@example.test',
      ]);
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, 'Disposable Creator', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [disposableProfileId, 'disposable-account-creator@example.test'],
      );

      const disposableAccId = subject(977);
      try {
        await seedAccount(disposableAccId, ws1Id, disposableProfileId);
        await expect(
          admin.query('delete from public.profiles where id = $1', [
            disposableProfileId,
          ]),
        ).rejects.toMatchObject({ code: '23503' });
      } finally {
        await deleteAccount(disposableAccId);
        await admin.query('delete from public.profiles where id = $1', [
          disposableProfileId,
        ]);
        await admin.query('delete from auth.users where id = $1', [
          disposableProfileId,
        ]);
      }
    });
  });

  describe('RLS behaviour', () => {
    const visibleAccId = subject(978);

    beforeAll(async () => {
      await seedAccount(visibleAccId, ws1Id, ownerA, {
        name: 'Visible Account',
      });
    });

    afterAll(async () => {
      await deleteAccount(visibleAccId);
    });

    it('12. Positive control: an owner can INSERT an account through the policy, proving the insert grant covers exactly the attempted columns', async () => {
      let insertedId: string | undefined;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.accounts (workspace_id, name, type, currency, institution, masked_number, description, include_in_net_worth, created_by)
             values ($1, $2, 'savings', 'USD', 'Test Bank', '****1234', 'Positive control', true, $3)
             returning id`,
            [ws1Id, 'Owner Positive Control', ownerA],
          );
        });
        insertedId = res.rows[0]?.id;
        expect(insertedId).toBeDefined();

        const check = await admin.query(
          'select 1 from public.accounts where id = $1',
          [insertedId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        if (insertedId) await deleteAccount(insertedId);
      }
    });

    it('13. A viewer CANNOT insert — refused with 42501 by the POLICY ("new row violates row-level security policy"), NOT by a missing grant; the identical insert by an owner succeeds in the same test', async () => {
      // The attempted insert names ONLY columns covered by the column-scoped
      // insert grant (workspace_id, name, type, currency, created_by). The
      // owner control below runs the identical statement successfully, so the
      // grant demonstrably covers these columns and the viewer's refusal can
      // only come from the policy's role list.
      const viewerErr = await capturePgError(() =>
        asSubject(viewerE, (client) =>
          client.query(
            `insert into public.accounts (workspace_id, name, type, currency, created_by)
             values ($1, 'Viewer Forbidden Account', 'cash', 'USD', $2)`,
            [ws1Id, viewerE],
          ),
        ),
      );
      expect(viewerErr.code).toBe('42501');
      expect(viewerErr.message ?? '').toContain('row-level security policy');
      expect(viewerErr.message ?? '').not.toContain('permission denied');

      const controlRes = await asSubject(ownerA, (client) =>
        client.query(
          `insert into public.accounts (workspace_id, name, type, currency, created_by)
           values ($1, 'Viewer Control Account', 'cash', 'USD', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const controlId: string | undefined = controlRes.rows[0]?.id;
      expect(controlId).toBeDefined();
      try {
        const check = await admin.query(
          'select 1 from public.accounts where id = $1',
          [controlId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        if (controlId) await deleteAccount(controlId);
      }
    });

    it('14. Inserting with created_by bound to a DIFFERENT profile is refused by the policy with 42501 (adapter-supplied attribution is forgeable)', async () => {
      const forgedErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.accounts (workspace_id, name, type, currency, created_by)
             values ($1, 'Forged Attribution Account', 'cash', 'USD', $2)`,
            [ws1Id, ownerB],
          ),
        ),
      );
      expect(forgedErr.code).toBe('42501');
      expect(forgedErr.message ?? '').toContain('row-level security policy');
    });

    it('15. An editor CANNOT move an account between workspaces: setting workspace_id is refused by the COLUMN-SCOPED GRANT (permission denied, NOT a row-level-security message); has_column_privilege pins the structural fact; positive control: the same editor updates a granted column', async () => {
      const targetId = subject(980);
      try {
        await seedAccount(targetId, ws1Id, ownerA, { name: 'Seizable Target' });

        const grantRes = await admin.query<{ updatable: boolean }>(
          `select has_column_privilege('savia_application', 'public.accounts', 'workspace_id', 'update') as updatable`,
        );
        expect(grantRes.rows[0].updatable).toBe(false);

        const seizureErr = await capturePgError(() =>
          asSubject(editorD, (client) =>
            client.query(
              'update public.accounts set workspace_id = $1 where id = $2',
              [ws2Id, targetId],
            ),
          ),
        );
        expect(seizureErr.code).toBe('42501');
        expect(seizureErr.message ?? '').toContain('permission denied');
        expect(seizureErr.message ?? '').not.toContain(
          'row-level security policy',
        );

        const untouched = await admin.query(
          'select workspace_id from public.accounts where id = $1',
          [targetId],
        );
        expect(untouched.rows[0].workspace_id).toBe(ws1Id);

        // Positive control: the SAME editor CAN update a granted column.
        const renameRes = await asSubject(editorD, (client) =>
          client.query('update public.accounts set name = $1 where id = $2', [
            'Renamed By Editor',
            targetId,
          ]),
        );
        expect(renameRes.rowCount).toBe(1);
      } finally {
        await deleteAccount(targetId);
      }
    });

    it('16. A closed account CANNOT be updated (using status <> closed filters it out): closing succeeds while active, afterwards updates affect ZERO rows and stored values stay unchanged', async () => {
      const closingId = subject(981);
      try {
        await seedAccount(closingId, ws1Id, ownerA, {
          name: 'Closing Candidate',
        });

        // Positive control: closing is reachable — active -> closed succeeds.
        const closeRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.accounts set status = 'closed', closed_at = now() where id = $1`,
            [closingId],
          ),
        );
        expect(closeRes.rowCount).toBe(1);

        // One-way: once closed, the row no longer matches `using`.
        const reopenRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.accounts set status = 'active', closed_at = null where id = $1`,
            [closingId],
          ),
        );
        expect(reopenRes.rowCount).toBe(0);

        const renameRes = await asSubject(adminC, (client) =>
          client.query('update public.accounts set name = $1 where id = $2', [
            'Mutated While Closed',
            closingId,
          ]),
        );
        expect(renameRes.rowCount).toBe(0);

        const stored = await admin.query(
          'select name, status, closed_at from public.accounts where id = $1',
          [closingId],
        );
        expect(stored.rows[0].status).toBe('closed');
        expect(stored.rows[0].name).toBe('Closing Candidate');
        expect(stored.rows[0].closed_at).not.toBeNull();
      } finally {
        await deleteAccount(closingId);
      }
    });

    it('17. An owner reads workspace accounts, a viewer reads them too, an outsider reads none', async () => {
      const ownerRes = await asSubject(ownerA, (client) =>
        client.query('select id from public.accounts where workspace_id = $1', [
          ws1Id,
        ]),
      );
      expect(ownerRes.rows.map((r) => r.id)).toContain(visibleAccId);

      const viewerRes = await asSubject(viewerE, (client) =>
        client.query('select id from public.accounts where workspace_id = $1', [
          ws1Id,
        ]),
      );
      expect(viewerRes.rows.map((r) => r.id)).toContain(visibleAccId);

      const outsiderRes = await asSubject(outsiderZ, (client) =>
        client.query('select id from public.accounts where workspace_id = $1', [
          ws1Id,
        ]),
      );
      expect(outsiderRes.rows).toHaveLength(0);
    });

    it('18. No delete is possible, BY GRANT: DELETE raises 42501 with a permission-denied message, not a row-level-security one', async () => {
      const delErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query('delete from public.accounts where id = $1', [
            visibleAccId,
          ]),
        ),
      );
      expect(delErr.code).toBe('42501');
      expect(delErr.message ?? '').toContain('permission denied');
      expect(delErr.message ?? '').not.toContain('row-level security policy');

      const stillThere = await admin.query(
        'select 1 from public.accounts where id = $1',
        [visibleAccId],
      );
      expect(stillThere.rows).toHaveLength(1);
    });
  });
});
