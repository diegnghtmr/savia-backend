// Migrations under test: 202609050002_report_runs.sql, 202609150001_report_runs_async.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for integration tests.');
}

const subject = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

type CapturedPgError = {
  code?: string;
  message?: string;
  constraint?: string;
};

async function capturePgError(
  run: () => Promise<unknown>,
): Promise<CapturedPgError> {
  try {
    await run();
  } catch (error: unknown) {
    return error as CapturedPgError;
  }
  throw new Error('Expected statement to fail, but it succeeded.');
}

describe('Report runs schema, named constraints, and RLS (202609050002_report_runs.sql)', () => {
  let admin: Pool;

  const ownerA = subject(8201);
  const adminA = subject(8202);
  const editorA = subject(8203);
  const viewerA = subject(8204);
  const outsiderZ = subject(8205);
  const ownerB = subject(8206);

  const ws1Id = '00000000-0000-4000-8000-000000008251';
  const ws2Id = '00000000-0000-4000-8000-000000008252';

  const defWs1Id = '00000000-0000-4000-8000-000000008261';
  const defWs2Id = '00000000-0000-4000-8000-000000008262';

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
       ($1, 'rr-owner-a@example.test'),
       ($2, 'rr-admin-a@example.test'),
       ($3, 'rr-editor-a@example.test'),
       ($4, 'rr-viewer-a@example.test'),
       ($5, 'rr-outsider-z@example.test'),
       ($6, 'rr-owner-b@example.test')`,
      [ownerA, adminA, editorA, viewerA, outsiderZ, ownerB],
    );

    for (const [id, email, name] of [
      [ownerA, 'rr-owner-a@example.test', 'RR Owner A'],
      [adminA, 'rr-admin-a@example.test', 'RR Admin A'],
      [editorA, 'rr-editor-a@example.test', 'RR Editor A'],
      [viewerA, 'rr-viewer-a@example.test', 'RR Viewer A'],
      [outsiderZ, 'rr-outsider-z@example.test', 'RR Outsider Z'],
      [ownerB, 'rr-owner-b@example.test', 'RR Owner B'],
    ]) {
      await admin.query(
        `insert into public.profiles (
           id, email, display_name, locale, country_code, timezone,
           date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled
         ) values (
           $1, $2, $3, 'en', 'US', 'UTC',
           'YYYY-MM-DD', 1, '1,234.56', 'USD', false
         )`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, created_by) values
       ($1, 'Workspace A', 'shared', 'USD', $2),
       ($3, 'Workspace B', 'shared', 'USD', $4)`,
      [ws1Id, ownerA, ws2Id, ownerB],
    );

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
       ($1, $2, 'owner', 'active'),
       ($1, $3, 'administrator', 'active'),
       ($1, $4, 'editor', 'active'),
       ($1, $5, 'viewer', 'active'),
       ($6, $7, 'owner', 'active')`,
      [ws1Id, ownerA, adminA, editorA, viewerA, ws2Id, ownerB],
    );

    // Create a report definition in workspace 1 and another in workspace 2
    await admin.query(
      `insert into public.report_definitions (
         id, workspace_id, name, dimensions, measures, visualization, created_by
       ) values
       ($1, $2, 'Def WS1', '["month"]'::jsonb, '["sum"]'::jsonb, 'table', $3),
       ($4, $5, 'Def WS2', '["month"]'::jsonb, '["sum"]'::jsonb, 'table', $6)`,
      [defWs1Id, ws1Id, ownerA, defWs2Id, ws2Id, ownerB],
    );
  });

  afterAll(async () => {
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      ws1Id,
      ws2Id,
    ]);
    await admin.query(
      `delete from auth.users where id in ($1, $2, $3, $4, $5, $6)`,
      [ownerA, adminA, editorA, viewerA, outsiderZ, ownerB],
    );
    await admin.end();
  });

  describe('Named constraints', () => {
    it('asserts report_runs_workspace_id_id_key composite unique constraint exists', async () => {
      // STRUCTURAL assertion, deliberately not behavioural. PostgreSQL checks the
      // primary key before this redundant unique constraint when id is duplicated;
      // catalog inspection is the only independent proof that the FK-required
      // composite unique constraint exists.
      const uqRes = await admin.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.report_runs'::regclass
            and conname = 'report_runs_workspace_id_id_key'
            and contype = 'u'`,
      );
      expect(uqRes.rows).toHaveLength(1);
      expect(uqRes.rows[0].def).toMatch(/unique \(workspace_id, id\)/i);
    });

    it('enforces report_runs_status_check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by
             ) values (
               $1, 'monthly_summary', 'invalid_status', 'json', $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_status_check');
    });

    it('enforces report_runs_format_check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by
             ) values (
               $1, 'monthly_summary', 'queued', 'xlsx', $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_format_check');
    });

    it('enforces report_runs_preset_check (12 preset values or null)', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by
             ) values (
               $1, 'custom_invalid_preset', 'queued', 'json', $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_preset_check');
    });

    it('enforces report_runs_definition_xor_preset_check: rejects both non-null', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, definition_id, preset, status, format, created_by
             ) values (
               $1, $2, 'monthly_summary', 'queued', 'json', $3
             )`,
            [ws1Id, defWs1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_definition_xor_preset_check');
    });

    it('enforces report_runs_definition_xor_preset_check: rejects both null', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, definition_id, preset, status, format, created_by
             ) values (
               $1, null, null, 'queued', 'json', $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_definition_xor_preset_check');
    });

    it('enforces report_runs_filters_is_object_check', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, filters, created_by
             ) values (
               $1, 'monthly_summary', 'queued', 'json', '["array"]'::jsonb, $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_filters_is_object_check');
    });

    it('enforces report_runs_definition_workspace_fkey: composite FK rejects cross-workspace definition_id', async () => {
      // Trying to insert in ws1 with definition from ws2
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, definition_id, status, format, created_by
             ) values (
               $1, $2, 'queued', 'json', $3
             )`,
            [ws1Id, defWs2Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('report_runs_definition_workspace_fkey');
    });

    it('enforces report_runs_completed_at_terminal_check: completed requires completed_at', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, completed_at, created_by
             ) values (
               $1, 'monthly_summary', 'completed', 'json', null, $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_completed_at_terminal_check');
    });

    it('enforces report_runs_completed_at_terminal_check: failed requires completed_at', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, completed_at, created_by
             ) values (
               $1, 'monthly_summary', 'failed', 'json', null, $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_completed_at_terminal_check');
    });

    it('enforces report_runs_completed_at_terminal_check: queued rejects completed_at', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, completed_at, created_by
             ) values (
               $1, 'monthly_summary', 'queued', 'json', now(), $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_completed_at_terminal_check');
    });

    it('enforces report_runs_job_workspace_fkey: a job of another workspace is refused', async () => {
      const foreignJobId = '00000000-0000-4000-8000-000000008271';
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, started_at, completed_at, created_by)
         values ($1, $2, 'balance_forecast', 'completed', now(), now(), $3)`,
        [foreignJobId, ws2Id, ownerB],
      );
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by, job_id
             ) values (
               $1, 'monthly_summary', 'queued', 'json', $2, $3
             )`,
            [ws1Id, ownerA, foreignJobId],
          );
        }),
      );
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('report_runs_job_workspace_fkey');
    });

    it('accepts a same-workspace job_id on report_runs', async () => {
      const jobId = '00000000-0000-4000-8000-000000008272';
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'balance_forecast', 'queued', $3)`,
        [jobId, ws1Id, ownerA],
      );
      const id = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `insert into public.report_runs (
             workspace_id, preset, status, format, created_by, job_id
           ) values (
             $1, 'monthly_summary', 'queued', 'json', $2, $3
           ) returning id`,
          [ws1Id, ownerA, jobId],
        );
        return res.rows[0]!.id;
      });
      expect(id).toBeDefined();
    });

    it('enforces report_runs_completed_at_terminal_check: processing rejects completed_at', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, completed_at, created_by
             ) values (
               $1, 'monthly_summary', 'processing', 'json', now(), $2
             )`,
            [ws1Id, ownerA],
          );
        }),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('report_runs_completed_at_terminal_check');
    });
  });

  describe('Row Level Security & Permissions', () => {
    it('allows owner, administrator, and editor to insert with matching definition', async () => {
      for (const actor of [ownerA, adminA, editorA]) {
        const id = await asSubject(actor, async (client) => {
          const res = await client.query<{ id: string }>(
            `insert into public.report_runs (
               workspace_id, definition_id, status, format, created_by
             ) values (
               $1, $2, 'queued', 'json', $3
             ) returning id`,
            [ws1Id, defWs1Id, actor],
          );
          return res.rows[0]!.id;
        });
        expect(id).toBeDefined();
      }
    });

    it('rejects insert by viewer role', async () => {
      const err = await capturePgError(() =>
        asSubject(viewerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by
             ) values (
               $1, 'monthly_summary', 'queued', 'json', $2
             )`,
            [ws1Id, viewerA],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('rejects insert by outsider', async () => {
      const err = await capturePgError(() =>
        asSubject(outsiderZ, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by
             ) values (
               $1, 'monthly_summary', 'queued', 'json', $2
             )`,
            [ws1Id, outsiderZ],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('rejects insert when created_by is forged', async () => {
      const err = await capturePgError(() =>
        asSubject(ownerA, async (client) => {
          await client.query(
            `insert into public.report_runs (
               workspace_id, preset, status, format, created_by
             ) values (
               $1, 'monthly_summary', 'queued', 'json', $2
             )`,
            [ws1Id, adminA],
          );
        }),
      );
      expect(err.code).toBe('42501');
    });

    it('allows viewer to select runs from their workspace, but isolates other workspaces', async () => {
      const ws1Runs = await asSubject(viewerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `select id from public.report_runs where workspace_id = $1`,
          [ws1Id],
        );
        return res.rows;
      });
      expect(ws1Runs.length).toBeGreaterThan(0);

      const crossWorkspaceRuns = await asSubject(viewerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `select id from public.report_runs where workspace_id = $1`,
          [ws2Id],
        );
        return res.rows;
      });
      expect(crossWorkspaceRuns).toHaveLength(0);
    });

    it('allows a processing report run to complete and refuses rewriting a completed artifact', async () => {
      const processingId = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `insert into public.report_runs (
             workspace_id, preset, status, format, created_by
           ) values (
             $1, 'monthly_summary', 'processing', 'json', $2
           ) returning id`,
          [ws1Id, ownerA],
        );
        return res.rows[0]!.id;
      });

      const completed = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ status: string }>(
          `update public.report_runs
              set status = 'completed',
                  completed_at = now(),
                  download_url = 'https://storage.example.test/report.json'
            where id = $1
            returning status`,
          [processingId],
        );
        return res.rows[0]?.status;
      });
      expect(completed).toBe('completed');

      const rewritten = await asSubject(ownerA, async (client) => {
        const res = await client.query<{ id: string }>(
          `update public.report_runs
              set download_url = 'https://storage.example.test/rewritten.json'
            where id = $1
            returning id`,
          [processingId],
        );
        return res.rowCount;
      });
      expect(rewritten).toBe(0);
    });
  });
});
