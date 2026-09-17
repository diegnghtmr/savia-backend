// Migration under test: 202609170001_receipt_ocr.sql
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

describe('Receipt OCR foundation schema, constraints, grants, and trigger (202609170001_receipt_ocr.sql)', () => {
  let admin: Pool;

  const ownerA = subject(9101);
  const editorA = subject(9102);
  const outsiderZ = subject(9103);

  const ws1Id = '00000000-0000-4000-8000-000000009151';
  const ws2Id = '00000000-0000-4000-8000-000000009152';
  const acct1Id = '00000000-0000-4000-8000-000000009161';

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
       ($1, 'ocr-owner-a@example.test'),
       ($2, 'ocr-editor-a@example.test'),
       ($3, 'ocr-outsider-z@example.test')
       on conflict (id) do nothing`,
      [ownerA, editorA, outsiderZ],
    );

    for (const [id, email, name] of [
      [ownerA, 'ocr-owner-a@example.test', 'OCR Owner A'],
      [editorA, 'ocr-editor-a@example.test', 'OCR Editor A'],
      [outsiderZ, 'ocr-outsider-z@example.test', 'OCR Outsider Z'],
    ]) {
      await admin.query(
        `insert into public.profiles (
           id, email, display_name, locale, country_code, timezone,
           date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled
         ) values (
           $1, $2, $3, 'en', 'US', 'UTC',
           'YYYY-MM-DD', 1, '1,234.56', 'USD', false
         ) on conflict (id) do nothing`,
        [id, email, name],
      );
    }

    for (const [wsId, ownerId, name] of [
      [ws1Id, ownerA, 'OCR Workspace 1'],
      [ws2Id, outsiderZ, 'OCR Workspace 2'],
    ]) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
         values ($1, $2, 'shared', 'USD', null, $3)
         on conflict (id) do nothing`,
        [wsId, name, ownerId],
      );
      await admin.query(
        `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
         values ($1, $2, 'owner', 'active')
         on conflict (workspace_id, profile_id) do nothing`,
        [wsId, ownerId],
      );
    }

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'editor', 'active')
       on conflict (workspace_id, profile_id) do nothing`,
      [ws1Id, editorA],
    );

    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, created_by)
       values ($1, $2, 'Test Account', 'checking', 'USD', $3)
       on conflict (id) do nothing`,
      [acct1Id, ws1Id, ownerA],
    );
  });

  afterAll(async () => {
    await admin.end();
  });

  describe('1. jobs_type_check admitting receipt_ocr & catalog pins', () => {
    it('pins the exact allowed values of jobs_type_check', async () => {
      const res = await admin.query<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def
           from pg_constraint c
           join pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'public'
            and c.conrelid = 'public.jobs'::regclass
            and c.conname = 'jobs_type_check'`,
      );
      expect(res.rows).toHaveLength(1);
      const def = res.rows[0].def;
      const types = Array.from(def.matchAll(/'([^']+)'/g), (m) => m[1]).sort();
      expect(types).toEqual([
        'balance_forecast',
        'export_job',
        'import_commit',
        'import_rollback',
        'receipt_ocr',
        'report_run',
      ]);
    });

    it('allows inserting a queued job with type receipt_ocr', async () => {
      const jobId = '00000000-0000-4000-8000-000000009201';
      const insertRes = await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)
         returning id, type, status`,
        [jobId, ws1Id, editorA],
      );
      expect(insertRes.rows).toHaveLength(1);
      expect(insertRes.rows[0].type).toBe('receipt_ocr');
      expect(insertRes.rows[0].status).toBe('queued');
    });

    it('rejects inserting an unlisted job type', async () => {
      const invalidJobId = '00000000-0000-4000-8000-000000009202';
      const err = await capturePgError(async () => {
        await admin.query(
          `insert into public.jobs (id, workspace_id, type, status, created_by)
           values ($1, $2, 'unknown_job_type', 'queued', $3)`,
          [invalidJobId, ws1Id, editorA],
        );
      });
      expect(err.code).toBe('23514'); // check_violation
      expect(err.constraint).toBe('jobs_type_check');
    });
  });

  describe('2. receipts columns, foreign key, and index', () => {
    it('verifies receipts has job_id and error columns with correct nullability and types', async () => {
      const res = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `select column_name, data_type, is_nullable
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'receipts'
            and column_name in ('job_id', 'error')
          order by column_name`,
      );
      expect(res.rows).toEqual([
        {
          column_name: 'error',
          data_type: 'jsonb',
          is_nullable: 'YES',
        },
        {
          column_name: 'job_id',
          data_type: 'uuid',
          is_nullable: 'YES',
        },
      ]);
    });

    it('enforces composite foreign key receipts_job_workspace_fkey', async () => {
      const jobId = '00000000-0000-4000-8000-000000009203';
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)`,
        [jobId, ws1Id, editorA],
      );

      // Same workspace succeeds
      const receiptId1 = '00000000-0000-4000-8000-000000009301';
      await admin.query(
        `insert into public.receipts (
           id, workspace_id, status, file_name, processing_location, storage_path,
           created_by, job_id
         ) values (
           $1, $2, 'uploaded', 'receipt.jpg', 'savia', 'workspaces/ws1/receipts/r1/receipt.jpg',
           $3, $4
         )`,
        [receiptId1, ws1Id, editorA, jobId],
      );

      // Non-existent job_id fails FK
      const receiptId2 = '00000000-0000-4000-8000-000000009302';
      const nonExistentJobId = '00000000-0000-4000-8000-000000009999';
      const errNonExistent = await capturePgError(async () => {
        await admin.query(
          `insert into public.receipts (
             id, workspace_id, status, file_name, processing_location, storage_path,
             created_by, job_id
           ) values (
             $1, $2, 'uploaded', 'receipt.jpg', 'savia', 'workspaces/ws1/receipts/r2/receipt.jpg',
             $3, $4
           )`,
          [receiptId2, ws1Id, editorA, nonExistentJobId],
        );
      });
      expect(errNonExistent.code).toBe('23503'); // foreign_key_violation
      expect(errNonExistent.constraint).toBe('receipts_job_workspace_fkey');

      // Cross-workspace job_id fails FK
      const receiptId3 = '00000000-0000-4000-8000-000000009303';
      const errCrossWorkspace = await capturePgError(async () => {
        await admin.query(
          `insert into public.receipts (
             id, workspace_id, status, file_name, processing_location, storage_path,
             created_by, job_id
           ) values (
             $1, $2, 'uploaded', 'receipt.jpg', 'savia', 'workspaces/ws2/receipts/r3/receipt.jpg',
             $3, $4
           )`,
          [receiptId3, ws2Id, outsiderZ, jobId], // jobId belongs to ws1Id
        );
      });
      expect(errCrossWorkspace.code).toBe('23503');
      expect(errCrossWorkspace.constraint).toBe('receipts_job_workspace_fkey');
    });

    it('verifies index receipts_workspace_job_idx exists on (workspace_id, job_id) where job_id is not null', async () => {
      const res = await admin.query<{ indexdef: string }>(
        `select indexdef
           from pg_indexes
          where schemaname = 'public'
            and tablename = 'receipts'
            and indexname = 'receipts_workspace_job_idx'`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].indexdef).toContain('(workspace_id, job_id)');
      expect(res.rows[0].indexdef).toContain('WHERE (job_id IS NOT NULL)');
    });
  });

  describe('3. Least-privilege grants and catalog pins per role', () => {
    it('pins savia_application column privileges on receipts exactly', async () => {
      const res = await admin.query<{
        column_name: string;
        privilege_type: string;
      }>(
        `select column_name, privilege_type
           from information_schema.column_privileges
          where table_schema = 'public'
            and table_name = 'receipts'
            and grantee = 'savia_application'
          order by privilege_type, column_name`,
      );

      const insertCols = res.rows
        .filter((r) => r.privilege_type === 'INSERT')
        .map((r) => r.column_name)
        .sort();
      const updateCols = res.rows
        .filter((r) => r.privilege_type === 'UPDATE')
        .map((r) => r.column_name)
        .sort();

      expect(insertCols).toEqual([
        'created_by',
        'currency',
        'date',
        'file_name',
        'id',
        'job_id',
        'merchant',
        'processing_location',
        'status',
        'storage_path',
        'total',
        'workspace_id',
      ]);

      expect(updateCols).toEqual([
        'currency',
        'date',
        'merchant',
        'status',
        'total',
        'transaction_id',
        'updated_at',
        'version',
      ]);

      // Assert positively that job_id and error have NO update grant
      expect(updateCols).not.toContain('job_id');
      expect(updateCols).not.toContain('error');
      // Assert positively that error has NO insert grant
      expect(insertCols).not.toContain('error');
    });

    it('pins savia_elevated table, column privileges, and RLS policies on receipts exactly', async () => {
      const tablePrivRes = await admin.query<{ privilege_type: string }>(
        `select privilege_type
           from information_schema.table_privileges
          where table_schema = 'public'
            and table_name = 'receipts'
            and grantee = 'savia_elevated'
          order by privilege_type`,
      );
      expect(tablePrivRes.rows.map((r) => r.privilege_type)).toEqual([
        'SELECT',
      ]);

      const colPrivRes = await admin.query<{
        column_name: string;
        privilege_type: string;
      }>(
        `select column_name, privilege_type
           from information_schema.column_privileges
          where table_schema = 'public'
            and table_name = 'receipts'
            and grantee = 'savia_elevated'
            and privilege_type = 'UPDATE'
          order by column_name`,
      );
      expect(colPrivRes.rows).toEqual([
        { column_name: 'error', privilege_type: 'UPDATE' },
        { column_name: 'status', privilege_type: 'UPDATE' },
        { column_name: 'updated_at', privilege_type: 'UPDATE' },
      ]);

      // RLS policies for savia_elevated
      const policiesRes = await admin.query<{
        policyname: string;
        cmd: string;
        roles: string[];
      }>(
        `select policyname, cmd, roles::text[] as roles
           from pg_policies
          where schemaname = 'public'
            and tablename = 'receipts'
            and 'savia_elevated' = any(roles)
          order by policyname`,
      );
      expect(policiesRes.rows).toEqual([
        {
          policyname: 'elevated_reads_receipts',
          cmd: 'SELECT',
          roles: ['savia_elevated'],
        },
        {
          policyname: 'elevated_updates_receipts',
          cmd: 'UPDATE',
          roles: ['savia_elevated'],
        },
      ]);
    });

    it('pins that savia_elevated retains no schema CREATE on public after migration', async () => {
      const privRes = await admin.query<{
        has_create: boolean;
        has_usage: boolean;
      }>(
        `select
           has_schema_privilege('savia_elevated', 'public', 'create') as has_create,
           has_schema_privilege('savia_elevated', 'public', 'usage') as has_usage`,
      );
      expect(privRes.rows[0]?.has_create).toBe(false);
      expect(privRes.rows[0]?.has_usage).toBe(true);
    });

    it('proves savia_application can INSERT job_id and UPDATE merchant/date/currency/total', async () => {
      const jobId = '00000000-0000-4000-8000-000000009204';
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)`,
        [jobId, ws1Id, editorA],
      );

      const receiptId = '00000000-0000-4000-8000-000000009304';
      await asSubject(editorA, async (client) => {
        await client.query(
          `insert into public.receipts (
             id, workspace_id, status, file_name, processing_location, storage_path,
             created_by, job_id
           ) values (
             $1, $2, 'uploaded', 'receipt.png', 'savia', 'workspaces/ws1/receipts/r4/receipt.png',
             $3, $4
           )`,
          [receiptId, ws1Id, editorA, jobId],
        );

        // Can update advisory fields
        const updateRes = await client.query(
          `update public.receipts
              set merchant = $1::jsonb,
                  date = $2::jsonb,
                  currency = $3::jsonb,
                  total = $4::jsonb
            where workspace_id = $5 and id = $6`,
          [
            JSON.stringify({ value: 'Test Store', confidence: 0.9 }),
            JSON.stringify({ value: '2026-09-17', confidence: 0.95 }),
            JSON.stringify({ value: 'USD', confidence: 0.99 }),
            JSON.stringify({ value: 1250, confidence: 0.9 }),
            ws1Id,
            receiptId,
          ],
        );
        expect(updateRes.rowCount).toBe(1);
      });
    });

    it('proves savia_application cannot UPDATE job_id (permission denied)', async () => {
      const receiptId = '00000000-0000-4000-8000-000000009304';
      const newJobId = '00000000-0000-4000-8000-000000009205';
      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)`,
        [newJobId, ws1Id, editorA],
      );

      const err = await capturePgError(async () => {
        await asSubject(editorA, async (client) => {
          await client.query(
            `update public.receipts set job_id = $1 where workspace_id = $2 and id = $3`,
            [newJobId, ws1Id, receiptId],
          );
        });
      });
      expect(err.code).toBe('42501'); // insufficient_privilege
    });

    it('proves savia_application cannot UPDATE error (permission denied)', async () => {
      const receiptId = '00000000-0000-4000-8000-000000009304';
      const err = await capturePgError(async () => {
        await asSubject(editorA, async (client) => {
          await client.query(
            `update public.receipts set error = '{"code":"test"}'::jsonb where workspace_id = $1 and id = $2`,
            [ws1Id, receiptId],
          );
        });
      });
      expect(err.code).toBe('42501'); // insufficient_privilege
    });
  });

  describe('4. Failure projection trigger & routine privilege pins', () => {
    it('pins that only savia_elevated has EXECUTE on project_receipt_job_failure', async () => {
      const privRes = await admin.query<{
        grantee: string;
        privilege_type: string;
      }>(
        `select grantee, privilege_type
           from information_schema.routine_privileges
          where specific_schema = 'public'
            and routine_name = 'project_receipt_job_failure'
          order by grantee, privilege_type`,
      );
      expect(privRes.rows).toEqual([
        { grantee: 'savia_elevated', privilege_type: 'EXECUTE' },
      ]);

      const appCanExec = await admin.query<{ can_exec: boolean }>(
        `select has_function_privilege('savia_application', 'public.project_receipt_job_failure()', 'execute') as can_exec`,
      );
      expect(appCanExec.rows[0].can_exec).toBe(false);

      const publicCanExec = await admin.query<{ can_exec: boolean }>(
        `select has_function_privilege('public', 'public.project_receipt_job_failure()', 'execute') as can_exec`,
      );
      expect(publicCanExec.rows[0].can_exec).toBe(false);

      const elevatedCanExec = await admin.query<{ can_exec: boolean }>(
        `select has_function_privilege('savia_elevated', 'public.project_receipt_job_failure()', 'execute') as can_exec`,
      );
      expect(elevatedCanExec.rows[0].can_exec).toBe(true);
    });

    it('projects job failed status and error onto linked receipt', async () => {
      const jobId = '00000000-0000-4000-8000-000000009210';
      const receiptId = '00000000-0000-4000-8000-000000009310';

      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)`,
        [jobId, ws1Id, editorA],
      );

      await admin.query(
        `insert into public.receipts (
           id, workspace_id, status, file_name, processing_location, storage_path,
           created_by, job_id
         ) values (
           $1, $2, 'uploaded', 'receipt.png', 'savia', 'workspaces/ws1/receipts/r10/receipt.png',
           $3, $4
         )`,
        [receiptId, ws1Id, editorA, jobId],
      );

      // Start the job
      await admin.query(
        `update public.jobs set status = 'processing', started_at = now() where id = $1`,
        [jobId],
      );

      const errorPayload = {
        type: 'https://savia.example.test/problems/ocr-failed',
        title: 'OCR engine failure',
        status: 422,
        code: 'ocr_engine_failed',
        traceId: '00000000-0000-4000-8000-000000009999',
      };

      // Fail the job
      await admin.query(
        `update public.jobs
            set status = 'failed',
                error = $2::jsonb,
                completed_at = now()
          where id = $1`,
        [jobId, JSON.stringify(errorPayload)],
      );

      const receiptRes = await admin.query<{
        status: string;
        error: Record<string, unknown>;
      }>(`select status, error from public.receipts where id = $1`, [
        receiptId,
      ]);

      expect(receiptRes.rows[0].status).toBe('failed');
      expect(receiptRes.rows[0].error).toEqual(errorPayload);
    });

    it('projects job dead_letter as status = failed onto linked receipt', async () => {
      const jobId = '00000000-0000-4000-8000-000000009211';
      const receiptId = '00000000-0000-4000-8000-000000009311';

      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)`,
        [jobId, ws1Id, editorA],
      );

      await admin.query(
        `insert into public.receipts (
           id, workspace_id, status, file_name, processing_location, storage_path,
           created_by, job_id
         ) values (
           $1, $2, 'uploaded', 'receipt.png', 'savia', 'workspaces/ws1/receipts/r11/receipt.png',
           $3, $4
         )`,
        [receiptId, ws1Id, editorA, jobId],
      );

      const errorPayload = {
        type: 'https://savia.example.test/problems/storage-timeout',
        title: 'Storage timeout exhausted retries',
        status: 504,
        code: 'storage_timeout',
        traceId: '00000000-0000-4000-8000-000000009998',
      };

      // Dead-letter the job
      await admin.query(
        `update public.jobs
            set status = 'dead_letter',
                error = $2::jsonb,
                started_at = coalesce(started_at, now()),
                completed_at = now()
          where id = $1`,
        [jobId, JSON.stringify(errorPayload)],
      );

      const receiptRes = await admin.query<{
        status: string;
        error: Record<string, unknown>;
      }>(`select status, error from public.receipts where id = $1`, [
        receiptId,
      ]);

      // Must be projected as 'failed', NEVER 'dead_letter'
      expect(receiptRes.rows[0].status).toBe('failed');
      expect(receiptRes.rows[0].error).toEqual(errorPayload);
    });

    it('never touches a receipt that is already confirmed with a transaction', async () => {
      const jobId = '00000000-0000-4000-8000-000000009212';
      const receiptId = '00000000-0000-4000-8000-000000009312';
      const txId = '00000000-0000-4000-8000-000000009412';

      await admin.query(
        `insert into public.jobs (id, workspace_id, type, status, created_by)
         values ($1, $2, 'receipt_ocr', 'queued', $3)`,
        [jobId, ws1Id, editorA],
      );

      // Create a transaction in ws1
      await admin.query(
        `insert into public.transactions (
           id, workspace_id, account_id, type, amount_minor, currency,
           occurred_at, created_by
         ) values (
           $1, $2, $3, 'expense', 5000, 'USD',
           '2026-09-17', $4
         ) on conflict (id) do nothing`,
        [txId, ws1Id, acct1Id, editorA],
      );

      // Receipt is confirmed
      await admin.query(
        `insert into public.receipts (
           id, workspace_id, status, file_name, processing_location, storage_path,
           created_by, job_id, transaction_id
         ) values (
           $1, $2, 'confirmed', 'receipt.png', 'savia', 'workspaces/ws1/receipts/r12/receipt.png',
           $3, $4, $5
         )`,
        [receiptId, ws1Id, editorA, jobId, txId],
      );

      // Fail the job
      await admin.query(
        `update public.jobs
            set status = 'failed',
                error = $2::jsonb,
                started_at = coalesce(started_at, now()),
                completed_at = now()
          where id = $1`,
        [
          jobId,
          JSON.stringify({
            type: 'https://savia.example.test/problems/too-late',
            title: 'Too late',
            status: 422,
            code: 'too_late',
            traceId: '00000000-0000-4000-8000-000000009997',
          }),
        ],
      );

      const receiptRes = await admin.query<{
        status: string;
        transaction_id: string;
        error: unknown;
      }>(
        `select status, transaction_id, error from public.receipts where id = $1`,
        [receiptId],
      );

      // Must remain confirmed, transaction intact, error null
      expect(receiptRes.rows[0].status).toBe('confirmed');
      expect(receiptRes.rows[0].transaction_id).toBe(txId);
      expect(receiptRes.rows[0].error).toBeNull();
    });
  });
});
