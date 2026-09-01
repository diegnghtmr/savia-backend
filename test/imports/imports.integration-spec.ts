// Migrations under test: 202608310005_import_jobs.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('import job schema', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
  });
  afterAll(() => pool.end());
  it('has workspace composite isolation and row-count identity constraints', async () => {
    const result = await pool.query<{ constraint_name: string }>(
      `select constraint_name from information_schema.table_constraints where table_schema='public' and table_name in ('import_jobs','import_job_rows') and constraint_name in ('import_jobs_workspace_id_id_key','import_jobs_counts_check','import_job_rows_parent_fk')`,
    );
    expect(result.rows.map((row) => row.constraint_name)).toEqual(
      expect.arrayContaining([
        'import_jobs_workspace_id_id_key',
        'import_jobs_counts_check',
        'import_job_rows_parent_fk',
      ]),
    );
  });
});
