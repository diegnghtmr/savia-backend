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

    it('Supporting indexes exist for created_by on categories, tags, and payees', async () => {
      for (const [table, idxName] of [
        ['public.categories', 'categories_created_by_idx'],
        ['public.tags', 'tags_created_by_idx'],
        ['public.payees', 'payees_created_by_idx'],
      ]) {
        const res = await admin.query<{ colnames: string[] }>(
          `select array_agg(a.attname::text order by k.ord) as colnames
             from pg_index i
             join pg_class idx on idx.oid = i.indexrelid
             join lateral unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where idx.relname = $1
              and i.indrelid = $2::regclass
              and i.indisunique = false`,
          [idxName, table],
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].colnames).toEqual(['created_by']);
      }
    });

    it('Exact grants are pinned: select, column-scoped insert and update present, delete/truncate/references/trigger absent on categories', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
        referenceable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.categories', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.categories', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.categories', column_name, 'update') as updatable,
                has_column_privilege('savia_application', 'public.categories', column_name, 'references') as referenceable
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

      const referenceable = result.rows
        .filter((r) => r.referenceable)
        .map((r) => r.column_name);
      expect(referenceable).toEqual([]);

      for (const priv of [
        'select',
        'insert',
        'update',
        'delete',
        'truncate',
        'references',
        'trigger',
      ] as const) {
        const tablePrivRes = await admin.query<{ has_priv: boolean }>(
          `select has_table_privilege('savia_application', 'public.categories', $1) as has_priv`,
          [priv],
        );
        expect(tablePrivRes.rows[0].has_priv).toBe(priv === 'select');
      }

      // Direct DELETE attempt as savia_application is rejected with 42501
      const deleteErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `delete from public.categories where id = '00000000-0000-0000-0000-000000000000'`,
          ),
        ),
      );
      expect(deleteErr.code).toBe('42501');
    });

    it('Exact grants are pinned: select, column-scoped insert and update present, delete/truncate/references/trigger absent on tags and payees', async () => {
      for (const table of ['tags', 'payees']) {
        const result = await admin.query<{
          column_name: string;
          readable: boolean;
          insertable: boolean;
          updatable: boolean;
          referenceable: boolean;
        }>(
          `select column_name,
                  has_column_privilege('savia_application', $1, column_name, 'select') as readable,
                  has_column_privilege('savia_application', $1, column_name, 'insert') as insertable,
                  has_column_privilege('savia_application', $1, column_name, 'update') as updatable,
                  has_column_privilege('savia_application', $1, column_name, 'references') as referenceable
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

        const referenceable = result.rows
          .filter((r) => r.referenceable)
          .map((r) => r.column_name);
        expect(referenceable).toEqual([]);

        for (const priv of [
          'select',
          'insert',
          'update',
          'delete',
          'truncate',
          'references',
          'trigger',
        ] as const) {
          const tablePrivRes = await admin.query<{ has_priv: boolean }>(
            `select has_table_privilege('savia_application', $1, $2) as has_priv`,
            [`public.${table}`, priv],
          );
          expect(tablePrivRes.rows[0].has_priv).toBe(priv === 'select');
        }

        const deleteErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `delete from public.${table} where id = '00000000-0000-0000-0000-000000000000'`,
            ),
          ),
        );
        expect(deleteErr.code).toBe('42501');
      }
    });

    it('Policies on categories, tags, and payees are pinned: predicates, commands, permissions, and complete role arrays', async () => {
      const getPolicies = async (tableName: string) => {
        const res = await admin.query<{
          polname: string;
          polcmd: string;
          polpermissive: boolean;
          roles: string[];
          polqual: string | null;
          polwithcheck: string | null;
        }>(
          `select p.polname,
                  p.polcmd::text as polcmd,
                  p.polpermissive,
                  (
                    select array_agg(pg_get_userbyid(r.oid)::text order by pg_get_userbyid(r.oid)::text)
                    from unnest(p.polroles) as r(oid)
                  ) as roles,
                  pg_get_expr(p.polqual, p.polrelid) as polqual,
                  pg_get_expr(p.polwithcheck, p.polrelid) as polwithcheck
             from pg_policy p
            where p.polrelid = $1::regclass
            order by p.polname`,
          [`public.${tableName}`],
        );
        return res.rows;
      };

      const categoriesPolicies = await getPolicies('categories');
      expect(categoriesPolicies).toEqual([
        {
          polname: 'application_inserts_workspace_category',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_category',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
        {
          polname: 'application_updates_workspace_category',
          polcmd: 'w',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text]))",
          polwithcheck:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text]))",
        },
        {
          polname: 'elevated_reads_categories',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_elevated'],
          polqual: 'true',
          polwithcheck: null,
        },
      ]);

      const tagsPolicies = await getPolicies('tags');
      expect(tagsPolicies).toEqual([
        {
          polname: 'application_inserts_workspace_tag',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_tag',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
        {
          polname: 'application_updates_workspace_tag',
          polcmd: 'w',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text]))",
          polwithcheck:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text]))",
        },
      ]);

      const payeesPolicies = await getPolicies('payees');
      expect(payeesPolicies).toEqual([
        {
          polname: 'application_inserts_workspace_payee',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_payee',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
        {
          polname: 'application_updates_workspace_payee',
          polcmd: 'w',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text]))",
          polwithcheck:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text]))",
        },
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

    it('3. RULING 48 COMPOSITE SELF-FK: category self-FK REJECTS a parent belonging to a different workspace on INSERT and UPDATE, and pg_constraint pins FK definition', async () => {
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

      // 2. Create a parent category in workspace 2
      const ws2ParentRes = await asSubject(ownerB, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Workspace 2 Parent', 'expense', $2)
           returning id`,
          [ws2Id, ownerB],
        ),
      );
      const ws2ParentId = ws2ParentRes.rows[0].id;

      try {
        // 3. Attempt to create a child category in workspace 2 referencing the parent in workspace 1
        // RULING 48 composite FK: (workspace_id, parent_id) references public.categories (workspace_id, id)
        // Must fail with SQLSTATE 23503 foreign_key_violation
        const crossWsInsertErr = await capturePgError(() =>
          asSubject(ownerB, (client) =>
            client.query(
              `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
               values ($1, $2, 'Cross-Workspace Child', 'expense', $3)`,
              [ws2Id, ws1ParentId, ownerB],
            ),
          ),
        );
        expect(crossWsInsertErr.code).toBe('23503');
        expect(crossWsInsertErr.message ?? '').toContain(
          'categories_parent_workspace_fkey',
        );

        // 4. Attempt to reference a completely non-existent parent_id in workspace 1
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

        // 5. Same workspace parent reference on INSERT SUCCEEDS
        const validChildRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Valid Sibling Child', 'expense', $3)
             returning id`,
            [ws1Id, ws1ParentId, ownerA],
          ),
        );
        const validChildId = validChildRes.rows[0].id;
        expect(validChildId).toBeDefined();

        // 6. Attempt to UPDATE existing workspace-1 category to point to workspace-2 parent -> rejected with 23503
        const crossWsUpdateErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.categories set parent_id = $1 where id = $2`,
              [ws2ParentId, validChildId],
            ),
          ),
        );
        expect(crossWsUpdateErr.code).toBe('23503');
        expect(crossWsUpdateErr.message ?? '').toContain(
          'categories_parent_workspace_fkey',
        );

        // 7. Assert via pg_constraint that FK source columns are (workspace_id, parent_id), target (workspace_id, id), and ON DELETE RESTRICT
        const fkRes = await admin.query<{
          conname: string;
          contype: string;
          confdeltype: string;
          conkey_cols: string[];
          confkey_cols: string[];
        }>(
          `select c.conname,
                  c.contype,
                  c.confdeltype,
                  array(
                    select a.attname::text
                    from unnest(c.conkey) with ordinality as k(attnum, ord)
                    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                    order by k.ord
                  ) as conkey_cols,
                  array(
                    select a.attname::text
                    from unnest(c.confkey) with ordinality as k(attnum, ord)
                    join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum
                    order by k.ord
                  ) as confkey_cols
             from pg_constraint c
            where c.conrelid = 'public.categories'::regclass
              and c.conname = 'categories_parent_workspace_fkey'`,
        );
        expect(fkRes.rows).toHaveLength(1);
        expect(fkRes.rows[0]).toEqual({
          conname: 'categories_parent_workspace_fkey',
          contype: 'f',
          confdeltype: 'r',
          conkey_cols: ['workspace_id', 'parent_id'],
          confkey_cols: ['workspace_id', 'id'],
        });

        await admin.query('delete from public.categories where id = $1', [
          validChildId,
        ]);
      } finally {
        await admin.query(
          'delete from public.categories where id = any($1::uuid[])',
          [[ws1ParentId, ws2ParentId]],
        );
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

    it('8. Positive updates assert rowCount === 1 and read back row correctly for owner, administrator, and editor on categories, tags, and payees', async () => {
      const catRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Positive Update Category', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const catId = catRes.rows[0].id;

      const tagRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'Positive Update Tag', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const tagId = tagRes.rows[0].id;

      const payeeRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'Positive Update Payee', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const payeeId = payeeRes.rows[0].id;

      try {
        for (const [subjectId, roleLabel] of [
          [ownerA, 'Owner'],
          [adminC, 'Admin'],
          [editorD, 'Editor'],
        ]) {
          // Category update
          const newCatName = `Cat Updated by ${roleLabel}`;
          const catUpdRes = await asSubject(subjectId, (client) =>
            client.query(
              `update public.categories set name = $1, archived = false where id = $2`,
              [newCatName, catId],
            ),
          );
          expect(catUpdRes.rowCount).toBe(1);
          const catRead = await asSubject(subjectId, (client) =>
            client.query<{ name: string; archived: boolean }>(
              `select name, archived from public.categories where id = $1`,
              [catId],
            ),
          );
          expect(catRead.rows[0].name).toBe(newCatName);
          expect(catRead.rows[0].archived).toBe(false);

          // Tag update
          const newTagName = `Tag Updated by ${roleLabel}`;
          const tagUpdRes = await asSubject(subjectId, (client) =>
            client.query(
              `update public.tags set name = $1, archived = false where id = $2`,
              [newTagName, tagId],
            ),
          );
          expect(tagUpdRes.rowCount).toBe(1);
          const tagRead = await asSubject(subjectId, (client) =>
            client.query<{ name: string; archived: boolean }>(
              `select name, archived from public.tags where id = $1`,
              [tagId],
            ),
          );
          expect(tagRead.rows[0].name).toBe(newTagName);
          expect(tagRead.rows[0].archived).toBe(false);

          // Payee update
          const newPayeeName = `Payee Updated by ${roleLabel}`;
          const payeeUpdRes = await asSubject(subjectId, (client) =>
            client.query(
              `update public.payees set name = $1, archived = false where id = $2`,
              [newPayeeName, payeeId],
            ),
          );
          expect(payeeUpdRes.rowCount).toBe(1);
          const payeeRead = await asSubject(subjectId, (client) =>
            client.query<{ name: string; archived: boolean }>(
              `select name, archived from public.payees where id = $1`,
              [payeeId],
            ),
          );
          expect(payeeRead.rows[0].name).toBe(newPayeeName);
          expect(payeeRead.rows[0].archived).toBe(false);
        }
      } finally {
        await admin.query('delete from public.categories where id = $1', [
          catId,
        ]);
        await admin.query('delete from public.tags where id = $1', [tagId]);
        await admin.query('delete from public.payees where id = $1', [payeeId]);
      }
    });

    it('9. Cross-workspace RLS isolation: owner A sees only workspace A, owner B only workspace B, cross-workspace update affects 0 rows, outsider sees none for categories, tags, and payees', async () => {
      // Seed in workspace 1
      const ws1CatRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Iso Cat WS1', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const ws1CatId = ws1CatRes.rows[0].id;

      const ws1TagRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'Iso Tag WS1', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const ws1TagId = ws1TagRes.rows[0].id;

      const ws1PayeeRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'Iso Payee WS1', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const ws1PayeeId = ws1PayeeRes.rows[0].id;

      // Seed in workspace 2
      const ws2CatRes = await asSubject(ownerB, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Iso Cat WS2', 'expense', $2)
           returning id`,
          [ws2Id, ownerB],
        ),
      );
      const ws2CatId = ws2CatRes.rows[0].id;

      const ws2TagRes = await asSubject(ownerB, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'Iso Tag WS2', $2)
           returning id`,
          [ws2Id, ownerB],
        ),
      );
      const ws2TagId = ws2TagRes.rows[0].id;

      const ws2PayeeRes = await asSubject(ownerB, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'Iso Payee WS2', $2)
           returning id`,
          [ws2Id, ownerB],
        ),
      );
      const ws2PayeeId = ws2PayeeRes.rows[0].id;

      try {
        // 1. Owner A reads only WS1
        const ownerACats = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `select id from public.categories where id = any($1::uuid[])`,
            [[ws1CatId, ws2CatId]],
          ),
        );
        expect(ownerACats.rows.map((r) => r.id)).toEqual([ws1CatId]);

        const ownerATags = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `select id from public.tags where id = any($1::uuid[])`,
            [[ws1TagId, ws2TagId]],
          ),
        );
        expect(ownerATags.rows.map((r) => r.id)).toEqual([ws1TagId]);

        const ownerAPayees = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `select id from public.payees where id = any($1::uuid[])`,
            [[ws1PayeeId, ws2PayeeId]],
          ),
        );
        expect(ownerAPayees.rows.map((r) => r.id)).toEqual([ws1PayeeId]);

        // 2. Owner B reads only WS2
        const ownerBCats = await asSubject(ownerB, (client) =>
          client.query<{ id: string }>(
            `select id from public.categories where id = any($1::uuid[])`,
            [[ws1CatId, ws2CatId]],
          ),
        );
        expect(ownerBCats.rows.map((r) => r.id)).toEqual([ws2CatId]);

        const ownerBTags = await asSubject(ownerB, (client) =>
          client.query<{ id: string }>(
            `select id from public.tags where id = any($1::uuid[])`,
            [[ws1TagId, ws2TagId]],
          ),
        );
        expect(ownerBTags.rows.map((r) => r.id)).toEqual([ws2TagId]);

        const ownerBPayees = await asSubject(ownerB, (client) =>
          client.query<{ id: string }>(
            `select id from public.payees where id = any($1::uuid[])`,
            [[ws1PayeeId, ws2PayeeId]],
          ),
        );
        expect(ownerBPayees.rows.map((r) => r.id)).toEqual([ws2PayeeId]);

        // 3. Owner A attempting to update WS2 row affects 0 rows
        const updateCatRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.categories set name = 'Hacked Cat' where id = $1`,
            [ws2CatId],
          ),
        );
        expect(updateCatRes.rowCount).toBe(0);

        const updateTagRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.tags set name = 'Hacked Tag' where id = $1`,
            [ws2TagId],
          ),
        );
        expect(updateTagRes.rowCount).toBe(0);

        const updatePayeeRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.payees set name = 'Hacked Payee' where id = $1`,
            [ws2PayeeId],
          ),
        );
        expect(updatePayeeRes.rowCount).toBe(0);

        // 4. Outsider reads none
        const outsiderCats = await asSubject(outsiderZ, (client) =>
          client.query(
            `select id from public.categories where id = any($1::uuid[])`,
            [[ws1CatId, ws2CatId]],
          ),
        );
        expect(outsiderCats.rows).toHaveLength(0);

        const outsiderTags = await asSubject(outsiderZ, (client) =>
          client.query(
            `select id from public.tags where id = any($1::uuid[])`,
            [[ws1TagId, ws2TagId]],
          ),
        );
        expect(outsiderTags.rows).toHaveLength(0);

        const outsiderPayees = await asSubject(outsiderZ, (client) =>
          client.query(
            `select id from public.payees where id = any($1::uuid[])`,
            [[ws1PayeeId, ws2PayeeId]],
          ),
        );
        expect(outsiderPayees.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.categories where id = any($1::uuid[])',
          [[ws1CatId, ws2CatId]],
        );
        await admin.query(
          'delete from public.tags where id = any($1::uuid[])',
          [[ws1TagId, ws2TagId]],
        );
        await admin.query(
          'delete from public.payees where id = any($1::uuid[])',
          [[ws1PayeeId, ws2PayeeId]],
        );
      }
    });

    it('10. Viewer and outsider restrictions: viewer can read but cannot insert/update; outsider cannot read or insert', async () => {
      const catRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Viewer Restrict Cat', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const catId = catRes.rows[0].id;

      const tagRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.tags (workspace_id, name, created_by)
           values ($1, 'Viewer Restrict Tag', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const tagId = tagRes.rows[0].id;

      const payeeRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.payees (workspace_id, name, created_by)
           values ($1, 'Viewer Restrict Payee', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const payeeId = payeeRes.rows[0].id;

      try {
        // Viewer can read
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

        // Viewer CANNOT insert (42501)
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

        // Viewer CANNOT update (0 rows updated)
        const viewerUpdateRes = await asSubject(viewerE, (client) =>
          client.query(
            `update public.categories set name = 'Viewer Mutated' where id = $1`,
            [catId],
          ),
        );
        expect(viewerUpdateRes.rowCount).toBe(0);

        // Outsider cannot read
        const outsiderReadRes = await asSubject(outsiderZ, (client) =>
          client.query(`select id from public.categories where id = $1`, [
            catId,
          ]),
        );
        expect(outsiderReadRes.rows).toHaveLength(0);

        // Outsider cannot insert (42501)
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
      } finally {
        await admin.query('delete from public.categories where id = $1', [
          catId,
        ]);
        await admin.query('delete from public.tags where id = $1', [tagId]);
        await admin.query('delete from public.payees where id = $1', [payeeId]);
      }
    });

    it('11. Forged created_by is rejected with 42501 on categories, tags, and payees', async () => {
      // Categories
      const catForgedErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.categories (workspace_id, name, kind, created_by)
             values ($1, 'Forged Category', 'expense', $2)`,
            [ws1Id, ownerB],
          ),
        ),
      );
      expect(catForgedErr.code).toBe('42501');

      // Tags
      const tagForgedErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.tags (workspace_id, name, created_by)
             values ($1, 'Forged Tag', $2)`,
            [ws1Id, ownerB],
          ),
        ),
      );
      expect(tagForgedErr.code).toBe('42501');

      // Payees
      const payeeForgedErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.payees (workspace_id, name, created_by)
             values ($1, 'Forged Payee', $2)`,
            [ws1Id, ownerB],
          ),
        ),
      );
      expect(payeeForgedErr.code).toBe('42501');
    });

    it('12. Category hierarchy cycle guard (RULING 50): self-cycles and multi-row cycles rejected, valid re-parent accepted', async () => {
      // 1. Self-parent A.parent_id = A.id on UPDATE is rejected with 23514 categories_parent_must_not_form_cycle
      const rootCatRes = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.categories (workspace_id, name, kind, created_by)
           values ($1, 'Cycle Root A', 'expense', $2)
           returning id`,
          [ws1Id, ownerA],
        ),
      );
      const rootCatId = rootCatRes.rows[0].id;

      try {
        const selfUpdateErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.categories set parent_id = $1 where id = $1`,
              [rootCatId],
            ),
          ),
        );
        expect(selfUpdateErr.code).toBe('23514');
        expect(selfUpdateErr.constraint).toBe(
          'categories_parent_must_not_form_cycle',
        );

        // 2. Self-parent on INSERT (explicit id === parent_id) is rejected with 23514 categories_parent_must_not_form_cycle
        const explicitId = randomUUID();
        const selfInsertErr = await capturePgError(() =>
          admin.query(
            `insert into public.categories (id, workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, $1, 'Self Parent Insert', 'expense', $3)`,
            [explicitId, ws1Id, ownerA],
          ),
        );
        expect(selfInsertErr.code).toBe('23514');
        expect(selfInsertErr.constraint).toBe(
          'categories_parent_must_not_form_cycle',
        );

        // 3. Two-row cycle: insert B under A, then UPDATE A to parent B -> rejected
        const childBRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Cycle Child B', 'expense', $3)
             returning id`,
            [ws1Id, rootCatId, ownerA],
          ),
        );
        const childBId = childBRes.rows[0].id;

        const twoRowCycleErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.categories set parent_id = $1 where id = $2`,
              [childBId, rootCatId],
            ),
          ),
        );
        expect(twoRowCycleErr.code).toBe('23514');
        expect(twoRowCycleErr.constraint).toBe(
          'categories_parent_must_not_form_cycle',
        );

        // 4. Three-row cycle: insert C under B, then UPDATE A to parent C -> rejected
        const childCRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, parent_id, name, kind, created_by)
             values ($1, $2, 'Cycle Child C', 'expense', $3)
             returning id`,
            [ws1Id, childBId, ownerA],
          ),
        );
        const childCId = childCRes.rows[0].id;

        const threeRowCycleErr = await capturePgError(() =>
          asSubject(ownerA, (client) =>
            client.query(
              `update public.categories set parent_id = $1 where id = $2`,
              [childCId, rootCatId],
            ),
          ),
        );
        expect(threeRowCycleErr.code).toBe('23514');
        expect(threeRowCycleErr.constraint).toBe(
          'categories_parent_must_not_form_cycle',
        );

        // 5. POSITIVE control: legitimate re-parent (move B from A to new root D) SUCCEEDS with rowCount === 1 and reads back correctly
        const rootDRes = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.categories (workspace_id, name, kind, created_by)
             values ($1, 'New Root D', 'expense', $2)
             returning id`,
            [ws1Id, ownerA],
          ),
        );
        const rootDId = rootDRes.rows[0].id;

        const reparentRes = await asSubject(ownerA, (client) =>
          client.query(
            `update public.categories set parent_id = $1 where id = $2`,
            [rootDId, childBId],
          ),
        );
        expect(reparentRes.rowCount).toBe(1);

        const readBack = await asSubject(ownerA, (client) =>
          client.query<{ parent_id: string }>(
            `select parent_id from public.categories where id = $1`,
            [childBId],
          ),
        );
        expect(readBack.rows[0].parent_id).toBe(rootDId);

        await admin.query(
          'delete from public.categories where id = any($1::uuid[])',
          [[childCId, childBId, rootDId]],
        );
      } finally {
        await admin.query('delete from public.categories where id = $1', [
          rootCatId,
        ]);
      }
    });
  });
});
