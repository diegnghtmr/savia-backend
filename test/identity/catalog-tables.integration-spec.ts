// Migrations under test: 202608290002_catalog_tables.sql
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

type CapturedPgError = { code?: string; message?: string; constraint?: string };

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

describe('Catalog tables schema, RULING 48 composite self-FK, uniqueness constraints, RLS, and grants (202608290002_catalog_tables.sql)', () => {
  let admin: Pool;

  const ownerA = subject(1201);
  const adminC = subject(1202);
  const editorD = subject(1203);
  const viewerE = subject(1204);
  const outsiderZ = subject(1205);
  const ownerB = subject(1206);

  const ws1Id = '00000000-0000-0000-0000-000000001251';
  const ws2Id = '00000000-0000-0000-0000-000000001252';

  const memOwnerAId = '00000000-0000-0000-0000-000000001261';
  const memAdminCId = '00000000-0000-0000-0000-000000001262';
  const memEditorDId = '00000000-0000-0000-0000-000000001263';
  const memViewerEId = '00000000-0000-0000-0000-000000001264';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000001265';

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

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        ownerA,
        'catalog-owner-a@example.test',
        adminC,
        'catalog-admin-c@example.test',
        editorD,
        'catalog-editor-d@example.test',
        viewerE,
        'catalog-viewer-e@example.test',
        outsiderZ,
        'catalog-outsider-z@example.test',
        ownerB,
        'catalog-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'catalog-owner-a@example.test', 'Catalog Owner A'],
      [adminC, 'catalog-admin-c@example.test', 'Catalog Admin C'],
      [editorD, 'catalog-editor-d@example.test', 'Catalog Editor D'],
      [viewerE, 'catalog-viewer-e@example.test', 'Catalog Viewer E'],
      [outsiderZ, 'catalog-outsider-z@example.test', 'Catalog Outsider Z'],
      [ownerB, 'catalog-owner-b@example.test', 'Catalog Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Catalog Shared Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Catalog Shared Workspace 2', 'shared', 'USD', null, $4)`,
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
    if (admin) {
      await admin
        .query(
          'delete from public.categories where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.tags where workspace_id = any($1::uuid[])', [
          [ws1Id, ws2Id],
        ])
        .catch(() => {});
      await admin
        .query(
          'delete from public.payees where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query('delete from public.workspaces where id = any($1::uuid[])', [
          [ws1Id, ws2Id],
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

  describe('Structure, catalog metadata, and ACL', () => {
    it('Catalog tables deliberately omit the fitness:financial tag', async () => {
      for (const table of [
        'public.categories',
        'public.tags',
        'public.payees',
      ]) {
        const res = await admin.query<{ description: string | null }>(
          `select obj_description($1::regclass) as description`,
          [table],
        );
        const description = res.rows[0]?.description;
        expect(description).not.toBeNull();
        expect(description).not.toContain('fitness:financial');
      }
    });

    it('public.categories, public.tags, and public.payees have relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_class
          where oid in (
            'public.categories'::regclass,
            'public.tags'::regclass,
            'public.payees'::regclass
          )
          order by relname`,
      );
      expect(rlsRes.rows).toEqual([
        {
          relname: 'categories',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        { relname: 'payees', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'tags', relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });

    it('The column inventory of all three tables is pinned', async () => {
      const getColumns = async (tableName: string) => {
        const res = await admin.query<{ column_name: string }>(
          `select column_name
             from information_schema.columns
            where table_schema = 'public' and table_name = $1
            order by column_name`,
          [tableName],
        );
        return res.rows.map((r) => r.column_name);
      };

      const categoriesColumns = await getColumns('categories');
      expect(categoriesColumns).toEqual([
        'archived',
        'color_token',
        'created_at',
        'created_by',
        'icon',
        'id',
        'kind',
        'name',
        'parent_id',
        'workspace_id',
      ]);

      const tagsColumns = await getColumns('tags');
      expect(tagsColumns).toEqual([
        'archived',
        'created_at',
        'created_by',
        'id',
        'name',
        'workspace_id',
      ]);

      const payeesColumns = await getColumns('payees');
      expect(payeesColumns).toEqual([
        'archived',
        'created_at',
        'created_by',
        'id',
        'name',
        'workspace_id',
      ]);
    });

    it('Exact grants are pinned: select, column-scoped insert and update present, delete absent on categories', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.categories', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.categories', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.categories', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'categories'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'archived',
        'color_token',
        'created_at',
        'created_by',
        'icon',
        'id',
        'kind',
        'name',
        'parent_id',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'archived',
        'color_token',
        'created_by',
        'icon',
        'kind',
        'name',
        'parent_id',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([
        'archived',
        'color_token',
        'icon',
        'kind',
        'name',
        'parent_id',
      ]);

      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.categories', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);

      const updateTableResult = await admin.query<{ has_update: boolean }>(
        `select has_table_privilege('savia_application', 'public.categories', 'update') as has_update`,
      );
      expect(updateTableResult.rows[0].has_update).toBe(false);
    });

    it('Exact grants are pinned: select, column-scoped insert and update present, delete absent on tags and payees', async () => {
      for (const table of ['tags', 'payees']) {
        const result = await admin.query<{
          column_name: string;
          readable: boolean;
          insertable: boolean;
          updatable: boolean;
        }>(
          `select column_name,
                  has_column_privilege('savia_application', $1, column_name, 'select') as readable,
                  has_column_privilege('savia_application', $1, column_name, 'insert') as insertable,
                  has_column_privilege('savia_application', $1, column_name, 'update') as updatable
             from information_schema.columns
            where table_schema = 'public' and table_name = $2
            order by column_name`,
          [`public.${table}`, table],
        );

        const readable = result.rows
          .filter((r) => r.readable)
          .map((r) => r.column_name);
        expect(readable).toEqual([
          'archived',
          'created_at',
          'created_by',
          'id',
          'name',
          'workspace_id',
        ]);

        const insertable = result.rows
          .filter((r) => r.insertable)
          .map((r) => r.column_name);
        expect(insertable).toEqual([
          'archived',
          'created_by',
          'name',
          'workspace_id',
        ]);

        const updatable = result.rows
          .filter((r) => r.updatable)
          .map((r) => r.column_name);
        expect(updatable).toEqual(['archived', 'name']);

        const delResult = await admin.query<{ has_delete: boolean }>(
          `select has_table_privilege('savia_application', $1, 'delete') as has_delete`,
          [`public.${table}`],
        );
        expect(delResult.rows[0].has_delete).toBe(false);

        const updateTableResult = await admin.query<{ has_update: boolean }>(
          `select has_table_privilege('savia_application', $1, 'update') as has_update`,
          [`public.${table}`],
        );
        expect(updateTableResult.rows[0].has_update).toBe(false);
      }
    });

    it('Policies on categories, tags, and payees are pinned: application reads, inserts, and updates present; no delete policy', async () => {
      const getPolicies = async (tableName: string) => {
        const res = await admin.query<{
          polname: string;
          polcmd: string;
          grantee: string | null;
        }>(
          `select p.polname,
                  p.polcmd::text as polcmd,
                  min(pg_get_userbyid(role_oid)) as grantee
             from pg_policy p
             cross join lateral unnest(p.polroles::oid[]) as role_oids(role_oid)
            where p.polrelid = $1::regclass
            group by p.polname, p.polcmd
            order by p.polname`,
          [`public.${tableName}`],
        );
        return res.rows.map((r) => [r.polname, r.polcmd, r.grantee]);
      };

      const categoriesPolicies = await getPolicies('categories');
      expect(categoriesPolicies).toEqual([
        ['application_inserts_workspace_category', 'a', 'savia_application'],
        ['application_reads_workspace_category', 'r', 'savia_application'],
        ['application_updates_workspace_category', 'w', 'savia_application'],
      ]);

      const tagsPolicies = await getPolicies('tags');
      expect(tagsPolicies).toEqual([
        ['application_inserts_workspace_tag', 'a', 'savia_application'],
        ['application_reads_workspace_tag', 'r', 'savia_application'],
        ['application_updates_workspace_tag', 'w', 'savia_application'],
      ]);

      const payeesPolicies = await getPolicies('payees');
      expect(payeesPolicies).toEqual([
        ['application_inserts_workspace_payee', 'a', 'savia_application'],
        ['application_reads_workspace_payee', 'r', 'savia_application'],
        ['application_updates_workspace_payee', 'w', 'savia_application'],
      ]);
    });
  });

  describe('Contract and Constraint Verification', () => {
    it('1. Name length CHECK constraints: 0 and 121 characters are refused with 23514 while 1 and 120 are accepted (BOTH edges)', async () => {
      const len0 = '';
      const len1 = 'A';
      const len120 = 'x'.repeat(120);
      const len121 = 'x'.repeat(121);

      // --- Categories ---
      const cat0Err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.categories (workspace_id, name, kind, created_by)
             values ($1, $2, 'expense', $3)`,
            [ws1Id, len0, ownerA],
          ),
        ),
      );
      expect(cat0Err.code).toBe('23514');
      expect(cat0Err.message ?? '').toContain('categories_name_length_check');

      const cat121Err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.categories (workspace_id, name, kind, created_by)
             values ($1, $2, 'expense', $3)`,
            [ws1Id, len121, ownerA],
          ),
        ),
      );
      expect(cat121Err.code).toBe('23514');
      expect(cat121Err.message ?? '').toContain('categories_name_length_check');

      const cat1Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, $2, 'expense', $3)
           returning id`,
          [ws1Id, len1, ownerA],
        ),
      );
      expect(cat1Res.rows[0].id).toBeDefined();

      const cat120Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, $2, 'expense', $3)
           returning id`,
          [ws1Id, len120, ownerA],
        ),
      );
      expect(cat120Res.rows[0].id).toBeDefined();

      // Clean up categories
      await admin.query(
        'delete from public.categories where id = any($1::uuid[])',
        [[cat1Res.rows[0].id, cat120Res.rows[0].id]],
      );

      // --- Tags ---
      const tag0Err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.tags (workspace_id, name, created_by)
             values ($1, $2, $3)`,
            [ws1Id, len0, ownerA],
          ),
        ),
      );
      expect(tag0Err.code).toBe('23514');
      expect(tag0Err.message ?? '').toContain('tags_name_length_check');

      const tag121Err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.tags (workspace_id, name, created_by)
             values ($1, $2, $3)`,
            [ws1Id, len121, ownerA],
          ),
        ),
      );
      expect(tag121Err.code).toBe('23514');
      expect(tag121Err.message ?? '').toContain('tags_name_length_check');

      const tag1Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, $2, $3)
           returning id`,
          [ws1Id, len1, ownerA],
        ),
      );
      expect(tag1Res.rows[0].id).toBeDefined();

      const tag120Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, $2, $3)
           returning id`,
          [ws1Id, len120, ownerA],
        ),
      );
      expect(tag120Res.rows[0].id).toBeDefined();

      await admin.query('delete from public.tags where id = any($1::uuid[])', [
        [tag1Res.rows[0].id, tag120Res.rows[0].id],
      ]);

      // --- Payees ---
      const payee0Err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.payees (workspace_id, name, created_by)
             values ($1, $2, $3)`,
            [ws1Id, len0, ownerA],
          ),
        ),
      );
      expect(payee0Err.code).toBe('23514');
      expect(payee0Err.message ?? '').toContain('payees_name_length_check');

      const payee121Err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.payees (workspace_id, name, created_by)
             values ($1, $2, $3)`,
            [ws1Id, len121, ownerA],
          ),
        ),
      );
      expect(payee121Err.code).toBe('23514');
      expect(payee121Err.message ?? '').toContain('payees_name_length_check');

      const payee1Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, $2, $3)
           returning id`,
          [ws1Id, len1, ownerA],
        ),
      );
      expect(payee1Res.rows[0].id).toBeDefined();

      const payee120Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, $2, $3)
           returning id`,
          [ws1Id, len120, ownerA],
        ),
      );
      expect(payee120Res.rows[0].id).toBeDefined();

      await admin.query(
        'delete from public.payees where id = any($1::uuid[])',
        [[payee1Res.rows[0].id, payee120Res.rows[0].id]],
      );
    });

    it('2. The category kind check rejects a value outside the enum (income, expense, transfer, other)', async () => {
      const invalidKindErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.categories (workspace_id, name, kind, created_by)
             values ($1, 'Investment', 'invalid_kind', $2)`,
            [ws1Id, ownerA],
          ),
        ),
      );
      expect(invalidKindErr.code).toBe('23514');
      expect(invalidKindErr.message ?? '').toContain('categories_kind_check');

      const validKinds = ['income', 'expense', 'transfer', 'other'] as const;
      const ids: string[] = [];
      for (const kind of validKinds) {
        const res = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, name, kind, created_by)
             values ($1, $2, $3, $4)
             returning id`,
            [ws1Id, `Category ${kind}`, kind, ownerA],
          ),
        );
        ids.push(res.rows[0].id);
      }
      expect(ids).toHaveLength(4);

      await admin.query(
        'delete from public.categories where id = any($1::uuid[])',
        [ids],
      );
    });

    it('3. RULING 48 COMPOSITE SELF-FK: category self-FK REJECTS a parent belonging to a different workspace (cross-workspace poison-row guard)', async () => {
      // 1. Create a parent category in workspace 1
      const ws1ParentRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Workspace 1 Parent', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const ws1ParentId = ws1ParentRes.rows[0].id;

      try {
        // 2. Attempt to create a child category in workspace 2 referencing the parent in workspace 1
        // RULING 48 composite FK: (workspace_id, parent_id) references public.categories (workspace_id, id)
        // Must fail with SQLSTATE 23503 foreign_key_violation
        const crossWsErr = await capturePgError(() =>
          asSubject(ownerB, (client) =>
            client.query(
              `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
               values ($1, $2, 'Cross-Workspace Child', 'expense', $3)`,
              [ws2Id, ws1ParentId, ownerB],
            ),
          ),
        );
        expect(crossWsErr.code).toBe('23503');
        expect(crossWsErr.message ?? '').toContain(
          'categories_parent_workspace_fkey',
        );

        // 3. Attempt to reference a completely non-existent parent_id in workspace 1
        const nonExistentParentErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
               values ($1, $2, 'Orphan Child', 'expense', $3)`,
              [ws1Id, randomUUID(), ownerA],
            ),
          ),
        );
        expect(nonExistentParentErr.code).toBe('23503');
        expect(nonExistentParentErr.message ?? '').toContain(
          'categories_parent_workspace_fkey',
        );

        // 4. Same workspace parent reference SUCCEEDS
        const validChildRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Valid Sibling Child', 'expense', $3)
             returning id`,
            [ws1Id, ws1ParentId, ownerA],
          ),
        );
        expect(validChildRes.rows[0].id).toBeDefined();

        await admin.query('delete from public.categories where id = $1', [
          validChildRes.rows[0].id,
        ]);
      } finally {
        await admin.query('delete from public.categories where id = $1', [
          ws1ParentId,
        ]);
      }
    });

    it('4. Duplicate names are refused for tags, payees, and sibling categories with 23505', async () => {
      // --- Tags duplicate name ---
      const tagRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'Tax2026', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const tagId = tagRes.rows[0].id;

      try {
        const dupTagErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.tags (workspace_id, name, created_by)
               values ($1, 'Tax2026', $2)`,
              [ws1Id, ownerA],
            ),
          ),
        );
        expect(dupTagErr.code).toBe('23505');
        expect(dupTagErr.message ?? '').toContain('tags_workspace_id_name_key');
      } finally {
        await admin.query('delete from public.tags where id = $1', [tagId]);
      }

      // --- Payees duplicate name ---
      const payeeRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'Electricity Company', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const payeeId = payeeRes.rows[0].id;

      try {
        const dupPayeeErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.payees (workspace_id, name, created_by)
               values ($1, 'Electricity Company', $2)`,
              [ws1Id, ownerA],
            ),
          ),
        );
        expect(dupPayeeErr.code).toBe('23505');
        expect(dupPayeeErr.message ?? '').toContain(
          'payees_workspace_id_name_key',
        );
      } finally {
        await admin.query('delete from public.payees where id = $1', [payeeId]);
      }

      // --- Sibling categories duplicate name under same parent ---
      const parentRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Parent Category Sibling Test', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const parentId = parentRes.rows[0].id;

      let child1Id: string | undefined;
      try {
        const child1Res = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Groceries', 'expense', $3)
             returning id`,
            [ws1Id, parentId, ownerA],
          ),
        );
        child1Id = child1Res.rows[0].id;

        const dupChildErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
               values ($1, $2, 'Groceries', 'expense', $3)`,
              [ws1Id, parentId, ownerA],
            ),
          ),
        );
        expect(dupChildErr.code).toBe('23505');
        expect(dupChildErr.message ?? '').toContain(
          'categories_workspace_parent_name_key',
        );
      } finally {
        if (child1Id) {
          await admin.query('delete from public.categories where id = $1', [
            child1Id,
          ]);
        }
        await admin.query('delete from public.categories where id = $1', [
          parentId,
        ]);
      }
    });

    it('5. Two categories under DIFFERENT parents MAY share the same name', async () => {
      const parent1Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Parent One', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const parent1Id = parent1Res.rows[0].id;

      const parent2Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Parent Two', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const parent2Id = parent2Res.rows[0].id;

      let child1Id: string | undefined;
      let child2Id: string | undefined;

      try {
        const child1Res = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Maintenance', 'expense', $3)
             returning id`,
            [ws1Id, parent1Id, ownerA],
          ),
        );
        child1Id = child1Res.rows[0].id;

        // Child with SAME name 'Maintenance' under Parent Two must succeed
        const child2Res = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Maintenance', 'expense', $3)
             returning id`,
            [ws1Id, parent2Id, ownerA],
          ),
        );
        child2Id = child2Res.rows[0].id;

        expect(child1Id).toBeDefined();
        expect(child2Id).toBeDefined();
        expect(child1Id).not.toEqual(child2Id);
      } finally {
        const toDelete = [child1Id, child2Id, parent1Id, parent2Id].filter(
          (id): id is string => Boolean(id),
        );
        await admin.query(
          'delete from public.categories where id = any($1::uuid[])',
          [toDelete],
        );
      }
    });

    it('6. Two TOP-LEVEL categories (parent_id is null) may NOT share a name (partial unique index)', async () => {
      const topLevel1Res = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
           values ($1, null, 'Housing', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const topLevel1Id = topLevel1Res.rows[0].id;

      try {
        // Attempting to create second top-level category with name 'Housing' must fail with 23505
        const dupTopLevelErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
               values ($1, null, 'Housing', 'expense', $2)`,
              [ws1Id, ownerA],
            ),
          ),
        );
        expect(dupTopLevelErr.code).toBe('23505');
        expect(dupTopLevelErr.message ?? '').toContain(
          'categories_workspace_top_level_name_idx',
        );

        // But in Workspace 2, top-level 'Housing' is permitted
        const ws2TopLevelRes = await asSubject(ownerB, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, null, 'Housing', 'expense', $2)
             returning id`,
            [ws2Id, ownerB],
          ),
        );
        expect(ws2TopLevelRes.rows[0].id).toBeDefined();
        await admin.query('delete from public.categories where id = $1', [
          ws2TopLevelRes.rows[0].id,
        ]);
      } finally {
        await admin.query('delete from public.categories where id = $1', [
          topLevel1Id,
        ]);
      }
    });

    it('7. Deleting a workspace cascades away all categories, tags, and payees', async () => {
      const tempWsId = randomUUID();
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
         values ($1, 'Temp Catalog Cascade Workspace', 'shared', 'USD', null, $2)`,
        [tempWsId, ownerA],
      );

      try {
        // Seed parent category
        const parentRes = await admin.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Temp Parent', 'expense', $2)
           returning id`,
          [tempWsId, ownerA],
        );
        const parentId = parentRes.rows[0].id;

        // Seed child category
        const childRes = await admin.query<{ id: string }>(
          `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
           values ($1, $2, 'Temp Child', 'expense', $3)
           returning id`,
          [tempWsId, parentId, ownerA],
        );
        const childId = childRes.rows[0].id;

        // Seed tag
        const tagRes = await admin.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'Temp Tag', $2)
           returning id`,
          [tempWsId, ownerA],
        );
        const tagId = tagRes.rows[0].id;

        // Seed payee
        const payeeRes = await admin.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'Temp Payee', $2)
           returning id`,
          [tempWsId, ownerA],
        );
        const payeeId = payeeRes.rows[0].id;

        // Verify seeded rows exist
        const catCountBefore = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.categories where workspace_id = $1`,
          [tempWsId],
        );
        expect(catCountBefore.rows[0].count).toBe('2');

        const tagCountBefore = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.tags where workspace_id = $1`,
          [tempWsId],
        );
        expect(tagCountBefore.rows[0].count).toBe('1');

        const payeeCountBefore = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.payees where workspace_id = $1`,
          [tempWsId],
        );
        expect(payeeCountBefore.rows[0].count).toBe('1');

        // Delete the workspace -> must cascade delete all categories, tags, and payees
        await admin.query('delete from public.workspaces where id = $1', [
          tempWsId,
        ]);

        const catCountAfter = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.categories where id = any($1::uuid[])`,
          [[parentId, childId]],
        );
        expect(catCountAfter.rows[0].count).toBe('0');

        const tagCountAfter = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.tags where id = $1`,
          [tagId],
        );
        expect(tagCountAfter.rows[0].count).toBe('0');

        const payeeCountAfter = await admin.query<{ count: string }>(
          `select count(*)::text as count from public.payees where id = $1`,
          [payeeId],
        );
        expect(payeeCountAfter.rows[0].count).toBe('0');
      } finally {
        await admin
          .query('delete from public.workspaces where id = $1', [tempWsId])
          .catch(() => {});
      }
    });

    it('8. RLS access control: role permissions, update capability, viewer/outsider restrictions, and forged created_by', async () => {
      // 1. Owner can insert category, tag, payee
      const catRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'RLS Test Category', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const catId = catRes.rows[0].id;

      const tagRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'RLS Test Tag', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const tagId = tagRes.rows[0].id;

      const payeeRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'RLS Test Payee', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const payeeId = payeeRes.rows[0].id;

      try {
        // 2. Editor can update category, tag, payee (including archiving)
        await asSubject(editorD, (client) =>
          client.query(
            `update public.categories
                set name = 'RLS Test Category Updated', archived = true
              where id = $1`,
            [catId],
          ),
        );
        const updatedCat = await asSubject(ownerA, (client) =>
          client.query<{ name: string; archived: boolean }>(
            `select name, archived from public.categories where id = $1`,
            [catId],
          ),
        );
        expect(updatedCat.rows[0].name).toBe('RLS Test Category Updated');
        expect(updatedCat.rows[0].archived).toBe(true);

        await asSubject(editorD, (client) =>
          client.query(
            `update public.tags
                set name = 'RLS Test Tag Updated', archived = true
              where id = $1`,
            [tagId],
          ),
        );

        await asSubject(editorD, (client) =>
          client.query(
            `update public.payees
                set name = 'RLS Test Payee Updated', archived = true
              where id = $1`,
            [payeeId],
          ),
        );

        // 3. Viewer can read
        const viewerCatRes = await asSubject(viewerE, (client) =>
          client.query(`select id from public.categories where id = $1`, [
            catId,
          ]),
        );
        expect(viewerCatRes.rows).toHaveLength(1);

        const viewerTagRes = await asSubject(viewerE, (client) =>
          client.query(`select id from public.tags where id = $1`, [tagId]),
        );
        expect(viewerTagRes.rows).toHaveLength(1);

        const viewerPayeeRes = await asSubject(viewerE, (client) =>
          client.query(`select id from public.payees where id = $1`, [payeeId]),
        );
        expect(viewerPayeeRes.rows).toHaveLength(1);

        // 4. Viewer CANNOT insert (42501)
        const viewerInsertErr = await capturePgError(() =>
          asSubject(viewerE, (client) =>
            client.query(
              `insert into public.categories (workspace_id, name, kind, created_by)
               values ($1, 'Viewer Category', 'income', $2)`,
              [ws1Id, viewerE],
            ),
          ),
        );
        expect(viewerInsertErr.code).toBe('42501');

        // 5. Viewer CANNOT update (0 rows updated or 42501)
        const viewerUpdateRes = await asSubject(viewerE, (client) =>
          client.query(
            `update public.categories set name = 'Viewer Mutated' where id = $1`,
            [catId],
          ),
        );
        expect(viewerUpdateRes.rowCount).toBe(0);

        // 6. Outsider cannot read
        const outsiderReadRes = await asSubject(outsiderZ, (client) =>
          client.query(`select id from public.categories where id = $1`, [
            catId,
          ]),
        );
        expect(outsiderReadRes.rows).toHaveLength(0);

        // 7. Outsider cannot insert (42501)
        const outsiderInsertErr = await capturePgError(() =>
          asSubject(outsiderZ, (client) =>
            client.query(
              `insert into public.tags (workspace_id, name, created_by)
               values ($1, 'Outsider Tag', $2)`,
              [ws1Id, outsiderZ],
            ),
          ),
        );
        expect(outsiderInsertErr.code).toBe('42501');

        // 8. Forged created_by (ownerA inserting with created_by = ownerB) is rejected with 42501
        const forgedCreatedByErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `insert into public.payees (workspace_id, name, created_by)
               values ($1, 'Forged Payee', $2)`,
              [ws1Id, ownerB],
            ),
          ),
        );
        expect(forgedCreatedByErr.code).toBe('42501');
      } finally {
        await admin.query('delete from public.categories where id = $1', [
          catId,
        ]);
        await admin.query('delete from public.tags where id = $1', [tagId]);
        await admin.query('delete from public.payees where id = $1', [payeeId]);
      }
    });
  });
});
