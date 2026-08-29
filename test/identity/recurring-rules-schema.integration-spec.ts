// Migrations under test: 202608290003_recurring_rules.sql
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

describe('Recurring rules schema, composite account FK, CHECK constraints, RLS, and grants (202608290003_recurring_rules.sql)', () => {
  let admin: Pool;

  const ownerA = subject(1401);
  const adminC = subject(1402);
  const editorD = subject(1403);
  const viewerE = subject(1404);
  const outsiderZ = subject(1405);
  const ownerB = subject(1406);

  const ws1Id = '00000000-0000-0000-0000-000000001451';
  const ws2Id = '00000000-0000-0000-0000-000000001452';

  const memOwnerAId = '00000000-0000-0000-0000-000000001461';
  const memAdminCId = '00000000-0000-0000-0000-000000001462';
  const memEditorDId = '00000000-0000-0000-0000-000000001463';
  const memViewerEId = '00000000-0000-0000-0000-000000001464';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000001465';

  const ws1AccountId = '00000000-0000-0000-0000-000000001471';
  const ws2AccountId = '00000000-0000-0000-0000-000000001472';

  const VALID_TEMPLATE = {
    type: 'expense',
    accountId: ws1AccountId,
    amount: {
      amountMinor: '5000',
      currency: 'USD',
    },
    occurredAt: '2026-08-29T12:00:00.000Z',
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

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        ownerA,
        'rec-owner-a@example.test',
        adminC,
        'rec-admin-c@example.test',
        editorD,
        'rec-editor-d@example.test',
        viewerE,
        'rec-viewer-e@example.test',
        outsiderZ,
        'rec-outsider-z@example.test',
        ownerB,
        'rec-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'rec-owner-a@example.test', 'Rec Owner A'],
      [adminC, 'rec-admin-c@example.test', 'Rec Admin C'],
      [editorD, 'rec-editor-d@example.test', 'Rec Editor D'],
      [viewerE, 'rec-viewer-e@example.test', 'Rec Viewer E'],
      [outsiderZ, 'rec-outsider-z@example.test', 'Rec Outsider Z'],
      [ownerB, 'rec-owner-b@example.test', 'Rec Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Rec Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Rec Workspace 2', 'shared', 'USD', null, $4)`,
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

    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'WS1 Checking', 'checking', 'USD', 'active', $3),
              ($4, $5, 'WS2 Checking', 'checking', 'USD', 'active', $6)`,
      [ws1AccountId, ws1Id, ownerA, ws2AccountId, ws2Id, ownerB],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin
        .query(
          'delete from public.recurring_rules where workspace_id = any($1::uuid[])',
          [[ws1Id, ws2Id]],
        )
        .catch(() => {});
      await admin
        .query(
          'delete from public.accounts where workspace_id = any($1::uuid[])',
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

  describe('Structure, metadata, and ACL', () => {
    it('public.recurring_rules has relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_class
          where oid = 'public.recurring_rules'::regclass`,
      );
      expect(rlsRes.rows).toEqual([
        {
          relname: 'recurring_rules',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ]);
    });

    it('The column inventory of public.recurring_rules is pinned', async () => {
      const res = await admin.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'recurring_rules'
          order by column_name`,
      );
      const cols = res.rows.map((r) => r.column_name);
      expect(cols).toEqual([
        'account_id',
        'active',
        'anchor_day_of_month',
        'behavior',
        'created_at',
        'created_by',
        'ends_at',
        'frequency',
        'id',
        'name',
        'next_occurrence_at',
        'rrule',
        'starts_at',
        'template',
        'workspace_id',
      ]);
    });

    it('Supporting indexes exist on public.recurring_rules', async () => {
      const res = await admin.query<{ relname: string }>(
        `select c.relname
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
          where i.indrelid = 'public.recurring_rules'::regclass
          order by c.relname`,
      );
      const idxNames = res.rows.map((r) => r.relname);
      expect(idxNames).toContain('recurring_rules_created_by_idx');
      expect(idxNames).toContain('recurring_rules_workspace_account_idx');
      expect(idxNames).toContain('recurring_rules_workspace_created_at_idx');
      expect(idxNames).toContain(
        'recurring_rules_workspace_next_occurrence_idx',
      );
    });

    it('Exact grants are pinned: select, column-scoped insert and update, delete/truncate/references/trigger absent', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
        referenceable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.recurring_rules', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.recurring_rules', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.recurring_rules', column_name, 'update') as updatable,
                has_column_privilege('savia_application', 'public.recurring_rules', column_name, 'references') as referenceable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'recurring_rules'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'account_id',
        'active',
        'anchor_day_of_month',
        'behavior',
        'created_at',
        'created_by',
        'ends_at',
        'frequency',
        'id',
        'name',
        'next_occurrence_at',
        'rrule',
        'starts_at',
        'template',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'account_id',
        'active',
        'anchor_day_of_month',
        'behavior',
        'created_by',
        'ends_at',
        'frequency',
        'name',
        'next_occurrence_at',
        'rrule',
        'starts_at',
        'template',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([
        'account_id',
        'active',
        'anchor_day_of_month',
        'behavior',
        'ends_at',
        'frequency',
        'name',
        'next_occurrence_at',
        'rrule',
        'starts_at',
        'template',
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
          `select has_table_privilege('savia_application', 'public.recurring_rules', $1) as has_priv`,
          [priv],
        );
        expect(tablePrivRes.rows[0].has_priv).toBe(priv === 'select');
      }

      // Direct DELETE attempt as savia_application is rejected with 42501
      const deleteErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `delete from public.recurring_rules where id = '00000000-0000-0000-0000-000000000000'`,
          ),
        ),
      );
      expect(deleteErr.code).toBe('42501');
    });

    it('Policies on public.recurring_rules are pinned: predicates, commands, permissions, and complete role arrays', async () => {
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
          where p.polrelid = 'public.recurring_rules'::regclass
          order by p.polname`,
      );

      expect(res.rows).toEqual([
        {
          polname: 'application_inserts_workspace_recurring_rules',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_recurring_rules',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
        {
          polname: 'application_updates_workspace_recurring_rules',
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

  describe('Constraint and Composite FK Verification', () => {
    it('1. Name length CHECK constraint: 0 and 121 characters are refused with 23514 while 1 and 120 are accepted', async () => {
      const len0 = '';
      const len1 = 'A';
      const len120 = 'x'.repeat(120);
      const len121 = 'x'.repeat(121);

      const err0 = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, $2, 'monthly', 'create_draft', $3, $4::jsonb, now(), 1, $5)`,
            [ws1Id, len0, ws1AccountId, JSON.stringify(VALID_TEMPLATE), ownerA],
          ),
        ),
      );
      expect(err0.code).toBe('23514');
      expect(err0.message ?? '').toContain('recurring_rules_name_length_check');

      const err121 = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, $2, 'monthly', 'create_draft', $3, $4::jsonb, now(), 1, $5)`,
            [
              ws1Id,
              len121,
              ws1AccountId,
              JSON.stringify(VALID_TEMPLATE),
              ownerA,
            ],
          ),
        ),
      );
      expect(err121.code).toBe('23514');
      expect(err121.message ?? '').toContain(
        'recurring_rules_name_length_check',
      );

      const res1 = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
           values ($1, $2, 'monthly', 'create_draft', $3, $4::jsonb, now(), 1, $5)
           returning id`,
          [ws1Id, len1, ws1AccountId, JSON.stringify(VALID_TEMPLATE), ownerA],
        ),
      );
      expect(res1.rows[0].id).toBeDefined();

      const res120 = await asSubject(ownerA, (client) =>
        client.query<{ id: string }>(
          `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
           values ($1, $2, 'monthly', 'create_draft', $3, $4::jsonb, now(), 1, $5)
           returning id`,
          [ws1Id, len120, ws1AccountId, JSON.stringify(VALID_TEMPLATE), ownerA],
        ),
      );
      expect(res120.rows[0].id).toBeDefined();

      await admin.query(
        'delete from public.recurring_rules where id = any($1::uuid[])',
        [[res1.rows[0].id, res120.rows[0].id]],
      );
    });

    it('2. Frequency CHECK constraint rejects invalid frequency enum values', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, 'Rule', 'hourly', 'create_draft', $2, $3::jsonb, now(), 1, $4)`,
            [ws1Id, ws1AccountId, JSON.stringify(VALID_TEMPLATE), ownerA],
          ),
        ),
      );
      expect(err.code).toBe('23514');
      expect(err.message ?? '').toContain('recurring_rules_frequency_check');

      const validFreqs = [
        'daily',
        'weekly',
        'biweekly',
        'monthly',
        'yearly',
        'custom',
      ] as const;
      const ids: string[] = [];
      for (const freq of validFreqs) {
        const res = await asSubject(ownerA, (client) =>
          client.query<{ id: string }>(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, $2, $3, 'create_draft', $4, $5::jsonb, now(), 1, $6)
             returning id`,
            [
              ws1Id,
              `Rule ${freq}`,
              freq,
              ws1AccountId,
              JSON.stringify(VALID_TEMPLATE),
              ownerA,
            ],
          ),
        );
        ids.push(res.rows[0].id);
      }
      expect(ids).toHaveLength(6);

      await admin.query(
        'delete from public.recurring_rules where id = any($1::uuid[])',
        [ids],
      );
    });

    it('3. Behavior CHECK constraint rejects invalid behavior enum values', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, 'Rule', 'monthly', 'instant_charge', $2, $3::jsonb, now(), 1, $4)`,
            [ws1Id, ws1AccountId, JSON.stringify(VALID_TEMPLATE), ownerA],
          ),
        ),
      );
      expect(err.code).toBe('23514');
      expect(err.message ?? '').toContain('recurring_rules_behavior_check');
    });

    it('4. RULING 48 / RULING 53 COMPOSITE ACCOUNT FK: rejects account belonging to a different workspace', async () => {
      // Attempt to create a recurring rule in workspace 1 referencing ws2AccountId (from workspace 2)
      const foreignAccountErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, 'Poison Rule', 'monthly', 'create_draft', $2, $3::jsonb, now(), 1, $4)`,
            [
              ws1Id,
              ws2AccountId, // cross-workspace account!
              JSON.stringify({ ...VALID_TEMPLATE, accountId: ws2AccountId }),
              ownerA,
            ],
          ),
        ),
      );

      expect(foreignAccountErr.code).toBe('23503');
      expect(foreignAccountErr.constraint).toBe(
        'recurring_rules_account_workspace_fkey',
      );
    });

    it('5. RLS role authorization: owner, administrator, editor can insert; viewer and outsider cannot', async () => {
      // 1. AdminC can insert in ws1
      const adminRes = await asSubject(adminC, (client) =>
        client.query<{ id: string }>(
          `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
           values ($1, 'Admin Rule', 'monthly', 'create_draft', $2, $3::jsonb, now(), 1, $4)
           returning id`,
          [ws1Id, ws1AccountId, JSON.stringify(VALID_TEMPLATE), adminC],
        ),
      );
      expect(adminRes.rows[0].id).toBeDefined();

      // 2. EditorD can insert in ws1
      const editorRes = await asSubject(editorD, (client) =>
        client.query<{ id: string }>(
          `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
           values ($1, 'Editor Rule', 'monthly', 'create_draft', $2, $3::jsonb, now(), 1, $4)
           returning id`,
          [ws1Id, ws1AccountId, JSON.stringify(VALID_TEMPLATE), editorD],
        ),
      );
      expect(editorRes.rows[0].id).toBeDefined();

      // 3. ViewerE CANNOT insert (fails RLS check with 42501)
      const viewerErr = await capturePgError(() =>
        asSubject(viewerE, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, 'Viewer Rule', 'monthly', 'create_draft', $2, $3::jsonb, now(), 1, $4)`,
            [ws1Id, ws1AccountId, JSON.stringify(VALID_TEMPLATE), viewerE],
          ),
        ),
      );
      expect(viewerErr.code).toBe('42501');

      // 4. OutsiderZ CANNOT insert or read
      const outsiderErr = await capturePgError(() =>
        asSubject(outsiderZ, (client) =>
          client.query(
            `insert into public.recurring_rules (workspace_id, name, frequency, behavior, account_id, template, next_occurrence_at, anchor_day_of_month, created_by)
             values ($1, 'Outsider Rule', 'monthly', 'create_draft', $2, $3::jsonb, now(), 1, $4)`,
            [ws1Id, ws1AccountId, JSON.stringify(VALID_TEMPLATE), outsiderZ],
          ),
        ),
      );
      expect(outsiderErr.code).toBe('42501');

      // 5. ViewerE CAN read
      const viewerReadRes = await asSubject(viewerE, (client) =>
        client.query<{ count: string }>(
          `select count(*)::text as count from public.recurring_rules where workspace_id = $1`,
          [ws1Id],
        ),
      );
      expect(Number(viewerReadRes.rows[0].count)).toBeGreaterThanOrEqual(2);

      // 6. OutsiderZ reads 0 rows due to RLS filter
      const outsiderReadRes = await asSubject(outsiderZ, (client) =>
        client.query<{ count: string }>(
          `select count(*)::text as count from public.recurring_rules where workspace_id = $1`,
          [ws1Id],
        ),
      );
      expect(Number(outsiderReadRes.rows[0].count)).toBe(0);

      await admin.query(
        'delete from public.recurring_rules where id = any($1::uuid[])',
        [[adminRes.rows[0].id, editorRes.rows[0].id]],
      );
    });
  });
});
