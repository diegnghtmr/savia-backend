// Migrations under test: 202608310001_jobs.sql
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

describe('Jobs schema, CHECK constraints, RLS, and grants (202608310001_jobs.sql)', () => {
  let admin: Pool;

  const ownerA = subject(3501);
  const adminC = subject(3502);
  const editorD = subject(3503);
  const viewerE = subject(3504);
  const outsiderZ = subject(3505);
  const ownerB = subject(3506);

  const ws1Id = '00000000-0000-0000-0000-000000003551';
  const ws2Id = '00000000-0000-0000-0000-000000003552';

  const memOwnerAId = '00000000-0000-0000-0000-000000003561';
  const memAdminCId = '00000000-0000-0000-0000-000000003562';
  const memEditorDId = '00000000-0000-0000-0000-000000003563';
  const memViewerEId = '00000000-0000-0000-0000-000000003564';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000003565';

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
        'job-owner-a@example.test',
        adminC,
        'job-admin-c@example.test',
        editorD,
        'job-editor-d@example.test',
        viewerE,
        'job-viewer-e@example.test',
        outsiderZ,
        'job-outsider-z@example.test',
        ownerB,
        'job-owner-b@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'job-owner-a@example.test', 'Job Owner A'],
      [adminC, 'job-admin-c@example.test', 'Job Admin C'],
      [editorD, 'job-editor-d@example.test', 'Job Editor D'],
      [viewerE, 'job-viewer-e@example.test', 'Job Viewer E'],
      [outsiderZ, 'job-outsider-z@example.test', 'Job Outsider Z'],
      [ownerB, 'job-owner-b@example.test', 'Job Owner B'],
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
    it('pins public.jobs table columns, nullabilities, and defaults', async () => {
      const result = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'jobs'
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
          name: 'type',
          type: 'text',
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
          name: 'progress_percent',
          type: 'integer',
          nullable: true,
          hasDefault: false,
        },
        {
          name: 'result_resource_id',
          type: 'uuid',
          nullable: true,
          hasDefault: false,
        },
        {
          name: 'error',
          type: 'jsonb',
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
          name: 'started_at',
          type: 'timestamp with time zone',
          nullable: true,
          hasDefault: false,
        },
        {
          name: 'completed_at',
          type: 'timestamp with time zone',
          nullable: true,
          hasDefault: false,
        },
      ]);
    });

    it('pins public.jobs constraints and foreign keys', async () => {
      const constraintsRes = await admin.query<{
        conname: string;
        contype: string;
      }>(
        `select conname, contype
           from pg_constraint
          where conrelid = 'public.jobs'::regclass
          order by conname`,
      );

      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toContain('jobs_pkey');
      expect(constraintNames).toContain('jobs_workspace_id_id_key');
      expect(constraintNames).toContain('jobs_workspace_id_fkey');
      expect(constraintNames).toContain('jobs_created_by_fkey');
      expect(constraintNames).toContain('jobs_type_check');
      expect(constraintNames).toContain('jobs_status_check');
      expect(constraintNames).toContain('jobs_progress_percent_range_check');
      expect(constraintNames).toContain('jobs_started_at_required_check');
      expect(constraintNames).toContain('jobs_completed_at_terminal_check');
      expect(constraintNames).toContain('jobs_error_only_when_failed_check');
      expect(constraintNames).toContain(
        'jobs_result_only_when_completed_check',
      );
    });

    it('enforces RLS and force row level security on public.jobs', async () => {
      const res = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
           from pg_class
          where oid = 'public.jobs'::regclass`,
      );
      expect(res.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('Pins COLUMN-SCOPED grants and rejects UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER for savia_application', async () => {
      const result = await admin.query<{
        column_name: string;
        insertable: boolean;
        updatable: boolean;
        referenceable: boolean;
      }>(
        `select c.column_name,
                has_column_privilege('savia_application', 'public.jobs', c.column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.jobs', c.column_name, 'update') as updatable,
                has_column_privilege('savia_application', 'public.jobs', c.column_name, 'references') as referenceable
           from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = 'jobs'
          order by c.column_name`,
      );

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'completed_at',
        'created_by',
        'error',
        'progress_percent',
        'result_resource_id',
        'started_at',
        'status',
        'type',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual([]);

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
          `select has_table_privilege('savia_application', 'public.jobs', $1) as has_priv`,
          [priv],
        );
        expect(tablePrivRes.rows[0].has_priv).toBe(priv === 'select');
      }

      // Direct DELETE attempt as savia_application is rejected with 42501
      const deleteErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `delete from public.jobs where id = '00000000-0000-0000-0000-000000000000'`,
          ),
        ),
      );
      expect(deleteErr.code).toBe('42501');

      // Direct UPDATE attempt as savia_application is rejected with 42501
      const updateErr = await capturePgError(() =>
        asSubject(ownerA, (client) =>
          client.query(
            `update public.jobs set status = 'processing' where id = '00000000-0000-0000-0000-000000000000'`,
          ),
        ),
      );
      expect(updateErr.code).toBe('42501');
    });

    it('Policies on public.jobs are pinned: predicates, commands, permissions, and complete role arrays', async () => {
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
          where p.polrelid = 'public.jobs'::regclass
          order by p.polname`,
      );

      expect(res.rows).toEqual([
        {
          polname: 'application_inserts_workspace_jobs',
          polcmd: 'a',
          polpermissive: true,
          roles: ['savia_application'],
          polqual: null,
          polwithcheck:
            "((workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text])) AND (created_by = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))",
        },
        {
          polname: 'application_reads_workspace_jobs',
          polcmd: 'r',
          polpermissive: true,
          roles: ['savia_application'],
          polqual:
            "(workspace_actor_active_role(workspace_id) = ANY (ARRAY['owner'::text, 'administrator'::text, 'editor'::text, 'viewer'::text]))",
          polwithcheck: null,
        },
      ]);
    });
  });

  describe('Functional & RLS Enforcements', () => {
    it('allows owner to insert a queued job and read it back', async () => {
      const jobId = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.jobs (
             workspace_id,
             type,
             status,
             progress_percent,
             created_by
           ) values (
             $1, $2, $3, $4, $5
           ) returning id`,
          [ws1Id, 'import_commit', 'queued', null, ownerA],
        );
        return ins.rows[0]!.id;
      });

      expect(jobId).toBeDefined();

      const readBack = await asSubject(ownerA, async (client) => {
        const sel = await client.query<{
          id: string;
          type: string;
          status: string;
        }>(`select id, type, status from public.jobs where id = $1`, [jobId]);
        return sel.rows[0];
      });

      expect(readBack?.type).toBe('import_commit');
      expect(readBack?.status).toBe('queued');
    });

    it('rejects forged created_by on insert (RLS with check violation)', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (
               workspace_id, type, status, created_by
             ) values (
               $1, $2, $3, $4
             )`,
            [ws1Id, 'import_commit', 'queued', adminC],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('rejects insert by viewer role (RLS with check violation)', async () => {
      const err = await capturePgError(() =>
        asSubject(viewerE, async (client) => {
          await client.query(
            `insert into public.jobs (
               workspace_id, type, status, created_by
             ) values (
               $1, $2, $3, $4
             )`,
            [ws1Id, 'import_commit', 'queued', viewerE],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });
  });

  describe('RULING 65 & RULING 67 CHECK Constraints', () => {
    it('enforces jobs_type_check: rejects invalid job type', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, created_by)
             values ($1, $2, $3, $4)`,
            [ws1Id, 'invalid_job_type', 'queued', ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('jobs_type_check');
    });

    it('enforces jobs_status_check: rejects invalid job status', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, created_by)
             values ($1, $2, $3, now(), $4)`,
            [ws1Id, 'import_commit', 'invalid_status', ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('jobs_status_check');
    });

    it('enforces jobs_progress_percent_range_check: rejects progress_percent < 0 or > 100', async () => {
      const errNegative = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, progress_percent, created_by)
             values ($1, $2, $3, $4, $5)`,
            [ws1Id, 'import_commit', 'queued', -1, ownerA],
          );
        }),
      );
      expect(errNegative.code).toBe('23514');
      expect(errNegative.constraint).toBe('jobs_progress_percent_range_check');

      const errOver100 = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, progress_percent, created_by)
             values ($1, $2, $3, $4, $5)`,
            [ws1Id, 'import_commit', 'queued', 101, ownerA],
          );
        }),
      );
      expect(errOver100.code).toBe('23514');
      expect(errOver100.constraint).toBe('jobs_progress_percent_range_check');
    });

    it('enforces jobs_started_at_required_check: queued cannot have started_at, non-queued must have started_at', async () => {
      // 1. status = queued with started_at -> fails
      const errQueuedWithStarted = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, created_by)
             values ($1, $2, $3, now(), $4)`,
            [ws1Id, 'import_commit', 'queued', ownerA],
          );
        }),
      );
      expect(errQueuedWithStarted.code).toBe('23514');
      expect(errQueuedWithStarted.constraint).toBe(
        'jobs_started_at_required_check',
      );

      // 2. status = processing with started_at = null -> fails
      const errProcessingWithoutStarted = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, created_by)
             values ($1, $2, $3, null, $4)`,
            [ws1Id, 'import_commit', 'processing', ownerA],
          );
        }),
      );
      expect(errProcessingWithoutStarted.code).toBe('23514');
      expect(errProcessingWithoutStarted.constraint).toBe(
        'jobs_started_at_required_check',
      );
    });

    it('enforces jobs_completed_at_terminal_check: terminal statuses require completed_at, non-terminal cannot have completed_at', async () => {
      // 1. status = completed with completed_at = null -> fails
      const errCompletedWithoutCompletedAt = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, completed_at, created_by)
             values ($1, $2, 'completed', now(), null, $3)`,
            [ws1Id, 'import_commit', ownerA],
          );
        }),
      );
      expect(errCompletedWithoutCompletedAt.code).toBe('23514');
      expect(errCompletedWithoutCompletedAt.constraint).toBe(
        'jobs_completed_at_terminal_check',
      );

      // 2. status = queued with completed_at set -> fails
      const errQueuedWithCompletedAt = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, completed_at, created_by)
             values ($1, $2, 'queued', now(), $3)`,
            [ws1Id, 'import_commit', ownerA],
          );
        }),
      );
      expect(errQueuedWithCompletedAt.code).toBe('23514');
      expect(errQueuedWithCompletedAt.constraint).toBe(
        'jobs_completed_at_terminal_check',
      );

      // 3. status = processing with completed_at set -> fails
      const errProcessingWithCompletedAt = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, completed_at, created_by)
             values ($1, $2, 'processing', now(), now(), $3)`,
            [ws1Id, 'import_commit', ownerA],
          );
        }),
      );
      expect(errProcessingWithCompletedAt.code).toBe('23514');
      expect(errProcessingWithCompletedAt.constraint).toBe(
        'jobs_completed_at_terminal_check',
      );
    });

    it('enforces jobs_error_only_when_failed_check: error is required for failed, forbidden for other statuses', async () => {
      // 1. status = failed with error = null -> fails
      const errFailedWithoutError = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, completed_at, error, created_by)
             values ($1, $2, 'failed', now(), now(), null, $3)`,
            [ws1Id, 'import_commit', ownerA],
          );
        }),
      );
      expect(errFailedWithoutError.code).toBe('23514');
      expect(errFailedWithoutError.constraint).toBe(
        'jobs_error_only_when_failed_check',
      );

      // 2. status = completed with error set -> fails
      const errCompletedWithError = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, completed_at, error, created_by)
             values ($1, $2, 'completed', now(), now(), '{"title":"error"}'::jsonb, $3)`,
            [ws1Id, 'import_commit', ownerA],
          );
        }),
      );
      expect(errCompletedWithError.code).toBe('23514');
      expect(errCompletedWithError.constraint).toBe(
        'jobs_error_only_when_failed_check',
      );
    });

    it('enforces jobs_result_only_when_completed_check: result_resource_id is forbidden unless status = completed', async () => {
      const someResourceId = '00000000-0000-0000-0000-000000003999';

      // 1. status = processing with result_resource_id set -> fails
      const errProcessingWithResult = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.jobs (workspace_id, type, status, started_at, result_resource_id, created_by)
             values ($1, $2, 'processing', now(), $3, $4)`,
            [ws1Id, 'import_commit', someResourceId, ownerA],
          );
        }),
      );
      expect(errProcessingWithResult.code).toBe('23514');
      expect(errProcessingWithResult.constraint).toBe(
        'jobs_result_only_when_completed_check',
      );

      // 2. status = completed with result_resource_id set -> succeeds
      const completedJobId = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.jobs (workspace_id, type, status, started_at, completed_at, result_resource_id, created_by)
           values ($1, $2, 'completed', now(), now(), $3, $4) returning id`,
          [ws1Id, 'import_commit', someResourceId, ownerA],
        );
        return ins.rows[0]!.id;
      });
      expect(completedJobId).toBeDefined();

      // 3. status = completed with result_resource_id null -> succeeds (e.g. rollback)
      const completedJobNoResultId = await asSubject(ownerA, async (client) => {
        const ins = await client.query<{ id: string }>(
          `insert into public.jobs (workspace_id, type, status, started_at, completed_at, result_resource_id, created_by)
           values ($1, $2, 'completed', now(), now(), null, $3) returning id`,
          [ws1Id, 'import_rollback', ownerA],
        );
        return ins.rows[0]!.id;
      });
      expect(completedJobNoResultId).toBeDefined();
    });
  });
});
