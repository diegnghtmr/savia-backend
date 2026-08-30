// Migrations under test: 202608290004_subscriptions.sql
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

describe('Subscriptions schema, CHECK constraints, RLS, and grants (202608290004_subscriptions.sql)', () => {
  let admin: Pool;

  const ownerA = subject(1501);
  const adminC = subject(1502);
  const editorD = subject(1503);
  const viewerE = subject(1504);
  const outsiderZ = subject(1505);
  const ownerB = subject(1506);

  const ws1Id = '00000000-0000-0000-0000-000000001551';
  const ws2Id = '00000000-0000-0000-0000-000000001552';

  const memOwnerAId = '00000000-0000-0000-0000-000000001561';
  const memAdminCId = '00000000-0000-0000-0000-000000001562';
  const memEditorDId = '00000000-0000-0000-0000-000000001563';
  const memViewerEId = '00000000-0000-0000-0000-000000001564';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000001565';

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
        'sub-owner-a@example.test',
        adminC,
        'sub-admin-c@example.test',
        editorD,
        'sub-editor-d@example.test',
        viewerE,
        'sub-viewer-e@example.test',
        outsiderZ,
        'sub-outsider-z@example.test',
        ownerB,
        'sub-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'sub-owner-a@example.test', 'Sub Owner A'],
      [adminC, 'sub-admin-c@example.test', 'Sub Admin C'],
      [editorD, 'sub-editor-d@example.test', 'Sub Editor D'],
      [viewerE, 'sub-viewer-e@example.test', 'Sub Viewer E'],
      [outsiderZ, 'sub-outsider-z@example.test', 'Sub Outsider Z'],
      [ownerB, 'sub-owner-b@example.test', 'Sub Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Workspace 1', 'shared', 'USD', null, $2),
              ($3, 'Workspace 2', 'shared', 'USD', null, $4)`,
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
    await admin.end();
  });

  describe('DDL & Introspection', () => {
    it('pins public.subscriptions table columns, nullabilities, and defaults', async () => {
      const result = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'subscriptions'
          order by ordinal_position`,
      );

      const columns = result.rows.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
        hasDefault: r.column_default !== null,
      }));

      expect(columns).toEqual([
        {
          name: 'id',
          type: 'uuid',
          nullable: false,
          hasDefault: true,
        },
        {
          name: 'workspace_id',
          type: 'uuid',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'payee_name',
          type: 'text',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'current_amount_minor',
          type: 'bigint',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'current_currency',
          type: 'character',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'previous_amount_minor',
          type: 'bigint',
          nullable: true,
          hasDefault: false,
        },
        {
          name: 'previous_currency',
          type: 'character',
          nullable: true,
          hasDefault: false,
        },
        {
          name: 'frequency',
          type: 'text',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'next_expected_at',
          type: 'timestamp with time zone',
          nullable: true,
          hasDefault: false,
        },
        {
          name: 'status',
          type: 'text',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'created_by',
          type: 'uuid',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'created_at',
          type: 'timestamp with time zone',
          nullable: false,
          hasDefault: true,
        },
      ]);
    });

    it('pins public.subscriptions constraints and foreign keys', async () => {
      const constraintsRes = await admin.query<{
        conname: string;
        contype: string;
      }>(
        `select conname, contype
           from pg_constraint
          where conrelid = 'public.subscriptions'::regclass
          order by conname`,
      );

      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toContain('subscriptions_pkey');
      expect(constraintNames).toContain('subscriptions_workspace_id_id_key');
      expect(constraintNames).toContain('subscriptions_workspace_id_fkey');
      expect(constraintNames).toContain('subscriptions_created_by_fkey');
      expect(constraintNames).toContain(
        'subscriptions_previous_amount_complete_check',
      );
      expect(constraintNames).toContain('subscriptions_status_check');
      expect(constraintNames).toContain(
        'subscriptions_payee_name_length_check',
      );
      expect(constraintNames).toContain(
        'subscriptions_current_currency_format_check',
      );
      expect(constraintNames).toContain(
        'subscriptions_previous_currency_format_check',
      );
      expect(constraintNames).toContain('subscriptions_frequency_length_check');
    });

    it('enforces RLS and force row level security on public.subscriptions', async () => {
      const res = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
           from pg_class
          where oid = 'public.subscriptions'::regclass`,
      );
      expect(res.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('Pins COLUMN-SCOPED grants and rejects TRUNCATE, REFERENCES, and TRIGGER for savia_application', async () => {
      const result = await admin.query<{
        column_name: string;
        insertable: boolean;
        updatable: boolean;
        referenceable: boolean;
      }>(
        `select c.column_name,
                has_column_privilege('savia_application', 'public.subscriptions', c.column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.subscriptions', c.column_name, 'update') as updatable,
                has_column_privilege('savia_application', 'public.subscriptions', c.column_name, 'references') as referenceable
           from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = 'subscriptions'
          order by c.column_name`,
      );

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'created_by',
        'current_amount_minor',
        'current_currency',
        'frequency',
        'next_expected_at',
        'payee_name',
        'previous_amount_minor',
        'previous_currency',
        'status',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([
        'current_amount_minor',
        'current_currency',
        'frequency',
        'next_expected_at',
        'payee_name',
        'previous_amount_minor',
        'previous_currency',
        'status',
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
          `select has_table_privilege('savia_application', 'public.subscriptions', $1) as has_priv`,
          [priv],
        );
        expect(tablePrivRes.rows[0].has_priv).toBe(priv === 'select');
      }

      // Direct DELETE attempt as savia_application is rejected with 42501
      const deleteErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `delete from public.subscriptions where id = '00000000-0000-0000-0000-000000000000'`,
          ),
        ),
      );
      expect(deleteErr.code).toBe('42501');
    });

    it('Policies on public.subscriptions are pinned: predicates, commands, permissions, and complete role arrays', async () => {
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
          where p.polrelid = 'public.subscriptions'::regclass
          order by p.polname`,
      );

      expect(res.rows).toEqual([
        {
          polname: 'application_inserts_workspace_subscriptions',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_subscriptions',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
        {
          polname: 'application_updates_workspace_subscriptions',
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

  describe('Functional & RLS Enforcements', () => {
    it('allows owner to insert a subscription and read it back', async () => {
      const subId = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.subscriptions (
             workspace_id,
             payee_name,
             current_amount_minor,
             current_currency,
             previous_amount_minor,
             previous_currency,
             frequency,
             next_expected_at,
             status,
             created_by
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           ) returning id`,
          [
            ws1Id,
            'Netflix',
            1599,
            'USD',
            null,
            null,
            'monthly',
            '2026-09-29T12:00:00Z',
            'detected',
            ownerA,
          ],
        );
        return ins.rows[0]!.id;
      });

      expect(subId).toBeDefined();

      const readBack = await asSubject(ownerA, async (client) => {
        const sel = await client.query<{ id: string; payee_name: string }>(
          `select id, payee_name from public.subscriptions where id = $1`,
          [subId],
        );
        return sel.rows[0];
      });

      expect(readBack?.payee_name).toBe('Netflix');
    });

    it('rejects forged created_by on insert (RLS with check violation)', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.subscriptions (
               workspace_id, payee_name, current_amount_minor, current_currency,
               previous_amount_minor, previous_currency, frequency, next_expected_at,
               status, created_by
             ) values (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
             )`,
            [
              ws1Id,
              'Spotify',
              999,
              'USD',
              null,
              null,
              'monthly',
              null,
              'detected',
              adminC, // Forged created_by
            ],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('rejects insert by viewer role (RLS with check violation)', async () => {
      const err = await capturePgError(() =>
        asSubject(viewerE, async (client) => {
          await client.query(
            `insert into public.subscriptions (
               workspace_id, payee_name, current_amount_minor, current_currency,
               previous_amount_minor, previous_currency, frequency, next_expected_at,
               status, created_by
             ) values (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
             )`,
            [
              ws1Id,
              'Spotify',
              999,
              'USD',
              null,
              null,
              'monthly',
              null,
              'detected',
              viewerE,
            ],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('enforces previous_amount completeness check (both or neither)', async () => {
      // 1. previous_amount_minor set, previous_currency null -> check violation
      const err1 = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.subscriptions (
               workspace_id, payee_name, current_amount_minor, current_currency,
               previous_amount_minor, previous_currency, frequency, status, created_by
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              ws1Id,
              'Gym',
              5000,
              'USD',
              4500,
              null,
              'monthly',
              'detected',
              ownerA,
            ],
          );
        }),
      );
      expect(err1.code).toBe('23514');
      expect(err1.constraint).toBe(
        'subscriptions_previous_amount_complete_check',
      );

      // 2. previous_amount_minor null, previous_currency set -> check violation
      const err2 = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.subscriptions (
               workspace_id, payee_name, current_amount_minor, current_currency,
               previous_amount_minor, previous_currency, frequency, status, created_by
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              ws1Id,
              'Gym',
              5000,
              'USD',
              null,
              'USD',
              'monthly',
              'detected',
              ownerA,
            ],
          );
        }),
      );
      expect(err2.code).toBe('23514');
      expect(err2.constraint).toBe(
        'subscriptions_previous_amount_complete_check',
      );

      // 3. both set -> succeeds
      const subWithPrev = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.subscriptions (
             workspace_id, payee_name, current_amount_minor, current_currency,
             previous_amount_minor, previous_currency, frequency, status, created_by
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            ws1Id,
            'Gym Complete',
            5000,
            'USD',
            4500,
            'USD',
            'monthly',
            'confirmed',
            ownerA,
          ],
        );
        return ins.rows[0]!.id;
      });
      expect(subWithPrev).toBeDefined();
    });

    it('enforces status enum check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.subscriptions (
               workspace_id, payee_name, current_amount_minor, current_currency,
               frequency, status, created_by
             ) values ($1, $2, $3, $4, $5, $6, $7)`,
            [ws1Id, 'Gym', 5000, 'USD', 'monthly', 'invalid_status', ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('subscriptions_status_check');
    });

    it('enforces payee_name length check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.subscriptions (
               workspace_id, payee_name, current_amount_minor, current_currency,
               frequency, status, created_by
             ) values ($1, $2, $3, $4, $5, $6, $7)`,
            [ws1Id, '', 5000, 'USD', 'monthly', 'detected', ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('subscriptions_payee_name_length_check');
    });
  });
});
