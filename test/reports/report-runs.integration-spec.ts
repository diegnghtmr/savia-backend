// Migrations under test: 202609050002_report_runs.sql
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createReportRunCommand,
  ReportRunCommandValidationError,
} from '../../src/reports/report-run-command.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('Report runs integration contract', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: url });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has the report runs table and terminal status constraint installed', async () => {
    const result = await pool.query<{
      tableName: string;
      constraintName: string;
    }>(
      `select c.relname as "tableName", con.conname as "constraintName"
         from pg_class c join pg_constraint con on con.conrelid = c.oid
        where c.relname = 'report_runs' and con.conname = 'report_runs_status_check'`,
    );
    expect(result.rows).toEqual([
      { tableName: 'report_runs', constraintName: 'report_runs_status_check' },
    ]);
  });

  it('rejects a request that does not select exactly one report shape', () => {
    expect(() => createReportRunCommand({ format: 'json' })).toThrow(
      ReportRunCommandValidationError,
    );
    expect(() =>
      createReportRunCommand({
        preset: 'expenses',
        definitionId: 'aaaaaaaa-0000-4000-8000-000000000001',
        format: 'json',
      }),
    ).toThrow(ReportRunCommandValidationError);
  });
});
