// Migrations under test: 202608310002_reconciliations.sql
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

describe('Reconciliations schema, CHECK constraints, RLS, and grants (202608310002_reconciliations.sql)', () => {
  let admin: Pool;

  const ownerA = subject(4501);
  const adminC = subject(4502);
  const editorD = subject(4503);
  const viewerE = subject(4504);
  const outsiderZ = subject(4505);
  const ownerB = subject(4506);

  const ws1Id = '00000000-0000-0000-0000-000000004551';
  const ws2Id = '00000000-0000-0000-0000-000000004552';

  const ws1Account1Id = '00000000-0000-0000-0000-000000004571';
  const ws2Account1Id = '00000000-0000-0000-0000-000000004572';

  const memOwnerAId = '00000000-0000-0000-0000-000000004561';
  const memAdminCId = '00000000-0000-0000-0000-000000004562';
  const memEditorDId = '00000000-0000-0000-0000-000000004563';
  const memViewerEId = '00000000-0000-0000-0000-000000004564';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000004565';

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

    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'WS1 Account', 'checking', 'USD', 'active', $3),
              ($4, $5, 'WS2 Account', 'checking', 'USD', 'active', $6)`,
      [ws1Account1Id, ws1Id, ownerA, ws2Account1Id, ws2Id, ownerB],
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(
        `delete from public.reconciliations where workspace_id in ($1, $2)`,
        [ws1Id, ws2Id],
      );
      await admin.query(
        `delete from public.accounts where workspace_id in ($1, $2)`,
        [ws1Id, ws2Id],
      );
      await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
        ws1Id,
        ws2Id,
      ]);
      await admin.query(
        `delete from auth.users where id in ($1, $2, $3, $4, $5, $6)`,
        [ownerA, adminC, editorD, viewerE, outsiderZ, ownerB],
      );
      await admin.end();
    }
  });

  describe('DDL & Introspection', () => {
    it('pins public.reconciliations table columns, nullabilities, and defaults', async () => {
      const result = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'reconciliations'
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
          name: 'account_id',
          type: 'uuid',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'statement_date',
          type: 'date',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'statement_balance_minor',
          type: 'bigint',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'statement_currency',
          type: 'character',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'system_balance_minor',
          type: 'bigint',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'difference_minor',
          type: 'bigint',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'status',
          type: 'text',
          nullable: false,
          hasDefault: false,
        },
        {
          name: 'notes',
          type: 'text',
          nullable: true,
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
        {
          name: 'completed_at',
          type: 'timestamp with time zone',
          nullable: true,
          hasDefault: false,
        },
      ]);
    });

    it('pins public.reconciliations constraints and foreign keys', async () => {
      const constraintsRes = await admin.query<{
        conname: string;
        contype: string;
      }>(
        `select conname, contype
           from pg_constraint
          where conrelid = 'public.reconciliations'::regclass
          order by conname`,
      );

      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toContain('reconciliations_pkey');
      expect(constraintNames).toContain('reconciliations_workspace_id_id_key');
      expect(constraintNames).toContain('reconciliations_workspace_id_fkey');
      expect(constraintNames).toContain(
        'reconciliations_account_workspace_fkey',
      );
      expect(constraintNames).toContain('reconciliations_created_by_fkey');
      expect(constraintNames).toContain(
        'reconciliations_statement_currency_format_check',
      );
      expect(constraintNames).toContain('reconciliations_status_check');
      expect(constraintNames).toContain('reconciliations_notes_length_check');
      expect(constraintNames).toContain('reconciliations_completed_at_check');
      expect(constraintNames).toContain(
        'reconciliations_difference_calculation_check',
      );
    });

    it('pins partial unique index reconciliations_one_open_per_account_idx (RULING 71)', async () => {
      const res = await admin.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef
           from pg_indexes
          where tablename = 'reconciliations'
            and indexname = 'reconciliations_one_open_per_account_idx'`,
      );

      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]?.indexdef).toContain('UNIQUE INDEX');
      expect(res.rows[0]?.indexdef).toContain("WHERE (status = 'open'::text)");
    });

    it('enforces RLS and force row level security on public.reconciliations', async () => {
      const res = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
           from pg_class
          where oid = 'public.reconciliations'::regclass`,
      );
      expect(res.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('pins COLUMN-SCOPED grants and rejects DELETE, TRUNCATE, REFERENCES, and TRIGGER for savia_application', async () => {
      const result = await admin.query<{
        column_name: string;
        insertable: boolean;
        updatable: boolean;
        referenceable: boolean;
      }>(
        `select c.column_name,
                has_column_privilege('savia_application', 'public.reconciliations', c.column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.reconciliations', c.column_name, 'update') as updatable,
                has_column_privilege('savia_application', 'public.reconciliations', c.column_name, 'references') as referenceable
           from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = 'reconciliations'
          order by c.column_name`,
      );

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'account_id',
        'created_by',
        'difference_minor',
        'notes',
        'statement_balance_minor',
        'statement_currency',
        'statement_date',
        'status',
        'system_balance_minor',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual(['completed_at', 'status']);

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
          `select has_table_privilege('savia_application', 'public.reconciliations', $1) as has_priv`,
          [priv],
        );
        expect(tablePrivRes.rows[0].has_priv).toBe(priv === 'select');
      }

      // Direct DELETE attempt as savia_application is rejected with 42501
      const deleteErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `delete from public.reconciliations where id = '00000000-0000-0000-0000-000000000000'`,
          ),
        ),
      );
      expect(deleteErr.code).toBe('42501');
    });

    it('pins policies on public.reconciliations', async () => {
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
          where p.polrelid = 'public.reconciliations'::regclass
          order by p.polname`,
      );

      expect(res.rows).toEqual([
        {
          polname: 'application_inserts_workspace_reconciliations',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_reconciliations',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
        {
          polname: 'application_updates_workspace_reconciliations',
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
    it('allows owner to insert an open reconciliation and read it back', async () => {
      const recId = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.reconciliations (
             workspace_id,
             account_id,
             statement_date,
             statement_balance_minor,
             statement_currency,
             system_balance_minor,
             difference_minor,
             status,
             created_by
           ) values (
             $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3
           ) returning id`,
          [ws1Id, ws1Account1Id, ownerA],
        );
        return ins.rows[0]!.id;
      });

      expect(recId).toBeDefined();

      const readBack = await asSubject(ownerA, async (client) => {
        const sel = await client.query<{
          id: string;
          status: string;
          statement_balance_minor: string;
          difference_minor: string;
        }>(
          `select id, status, statement_balance_minor, difference_minor
             from public.reconciliations where id = $1`,
          [recId],
        );
        return sel.rows[0];
      });

      expect(readBack?.status).toBe('open');
      expect(readBack?.statement_balance_minor).toBe('10000');
      expect(readBack?.difference_minor).toBe('2000');

      // Cleanup
      await admin.query(`delete from public.reconciliations where id = $1`, [
        recId,
      ]);
    });

    it('rejects forged created_by on insert (RLS check violation)', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3
             )`,
            [ws1Id, ws1Account1Id, adminC],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('rejects insert by viewer role (RLS check violation)', async () => {
      const err = await capturePgError(() =>
        asSubject(viewerE, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3
             )`,
            [ws1Id, ws1Account1Id, viewerE],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });
  });

  describe('CHECK Constraints and Integrity Invariants', () => {
    it('enforces reconciliations_statement_currency_format_check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'usd', 8000, 2000, 'open', $3
             )`,
            [ws1Id, ws1Account1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe(
        'reconciliations_statement_currency_format_check',
      );
    });

    it('enforces reconciliations_status_check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'invalid_status', $3
             )`,
            [ws1Id, ws1Account1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('reconciliations_status_check');
    });

    it('enforces reconciliations_notes_length_check', async () => {
      const longNotes = 'x'.repeat(1001);
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, notes, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3, $4
             )`,
            [ws1Id, ws1Account1Id, longNotes, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('reconciliations_notes_length_check');
    });

    it('enforces reconciliations_completed_at_check (RULING 74)', async () => {
      // 1. status = completed with completed_at = null -> fails
      const errCompletedNull = await capturePgError(() =>
        admin.query(
          `insert into public.reconciliations (
             workspace_id, account_id, statement_date, statement_balance_minor,
             statement_currency, system_balance_minor, difference_minor, status, completed_at, created_by
           ) values (
             $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'completed', null, $3
           )`,
          [ws1Id, ws1Account1Id, ownerA],
        ),
      );
      expect(errCompletedNull.code).toBe('23514');
      expect(errCompletedNull.constraint).toBe(
        'reconciliations_completed_at_check',
      );

      // 2. status = open with completed_at set -> fails
      const errOpenWithCompletedAt = await capturePgError(() =>
        admin.query(
          `insert into public.reconciliations (
             workspace_id, account_id, statement_date, statement_balance_minor,
             statement_currency, system_balance_minor, difference_minor, status, completed_at, created_by
           ) values (
             $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', now(), $3
           )`,
          [ws1Id, ws1Account1Id, ownerA],
        ),
      );
      expect(errOpenWithCompletedAt.code).toBe('23514');
      expect(errOpenWithCompletedAt.constraint).toBe(
        'reconciliations_completed_at_check',
      );

      // 3. Update path via asSubject: updating status to completed without completed_at fails
      const recId = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.reconciliations (
             workspace_id, account_id, statement_date, statement_balance_minor,
             statement_currency, system_balance_minor, difference_minor, status, created_by
           ) values (
             $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3
           ) returning id`,
          [ws1Id, ws1Account1Id, ownerA],
        );
        return ins.rows[0]!.id;
      });

      const errUpdateCompletedNull = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `update public.reconciliations set status = 'completed', completed_at = null where id = $1`,
            [recId],
          ),
        ),
      );
      expect(errUpdateCompletedNull.code).toBe('23514');
      expect(errUpdateCompletedNull.constraint).toBe(
        'reconciliations_completed_at_check',
      );

      // Clean up
      await admin.query(`delete from public.reconciliations where id = $1`, [
        recId,
      ]);
    });

    it('enforces reconciliations_difference_calculation_check (difference = statementBalance - systemBalance)', async () => {
      // statementBalance = 10000, systemBalance = 8000, correct difference = 2000.
      // Passing difference = 3000 -> fails
      const errWrongDiff = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'USD', 8000, 3000, 'open', $3
             )`,
            [ws1Id, ws1Account1Id, ownerA],
          );
        }),
      );
      expect(errWrongDiff.code).toBe('23514');
      expect(errWrongDiff.constraint).toBe(
        'reconciliations_difference_calculation_check',
      );
    });

    it('enforces composite foreign key reconciliations_account_workspace_fkey (RULING 48 / RULING 73)', async () => {
      // Attempt to reference ws2Account1Id from workspace ws1Id
      const errCrossWorkspace = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3
             )`,
            [ws1Id, ws2Account1Id, ownerA],
          );
        }),
      );
      expect(errCrossWorkspace.code).toBe('23503');
      expect(errCrossWorkspace.constraint).toBe(
        'reconciliations_account_workspace_fkey',
      );
    });

    it('enforces partial unique index reconciliations_one_open_per_account_idx (RULING 71)', async () => {
      // 1. Insert first open reconciliation
      const rec1Id = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.reconciliations (
             workspace_id, account_id, statement_date, statement_balance_minor,
             statement_currency, system_balance_minor, difference_minor, status, created_by
           ) values (
             $1, $2, '2026-08-31', 10000, 'USD', 8000, 2000, 'open', $3
           ) returning id`,
          [ws1Id, ws1Account1Id, ownerA],
        );
        return ins.rows[0]!.id;
      });

      // 2. Second open reconciliation for the same account must fail with 23505
      const errSecondOpen = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.reconciliations (
               workspace_id, account_id, statement_date, statement_balance_minor,
               statement_currency, system_balance_minor, difference_minor, status, created_by
             ) values (
               $1, $2, '2026-08-31', 12000, 'USD', 8000, 4000, 'open', $3
             )`,
            [ws1Id, ws1Account1Id, ownerA],
          );
        }),
      );
      expect(errSecondOpen.code).toBe('23505');
      expect(errSecondOpen.constraint).toBe(
        'reconciliations_one_open_per_account_idx',
      );

      // Verify row count remains exactly 1
      const countRes = await admin.query<{ count: string }>(
        `select count(*)::text from public.reconciliations where workspace_id = $1 and account_id = $2`,
        [ws1Id, ws1Account1Id],
      );
      expect(countRes.rows[0]?.count).toBe('1');

      // 3. Mark the first one as completed -> now a new open reconciliation CAN be inserted
      await admin.query(
        `update public.reconciliations set status = 'completed', completed_at = now() where id = $1`,
        [rec1Id],
      );

      const rec2Id = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.reconciliations (
             workspace_id, account_id, statement_date, statement_balance_minor,
             statement_currency, system_balance_minor, difference_minor, status, created_by
           ) values (
             $1, $2, '2026-08-31', 12000, 'USD', 8000, 4000, 'open', $3
           ) returning id`,
          [ws1Id, ws1Account1Id, ownerA],
        );
        return ins.rows[0]!.id;
      });
      expect(rec2Id).toBeDefined();

      // Cleanup
      await admin.query(
        `delete from public.reconciliations where id in ($1, $2)`,
        [rec1Id, rec2Id],
      );
    });
  });
});
