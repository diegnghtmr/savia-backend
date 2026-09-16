import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresReportAdapter } from '../../src/reports/postgres-report.adapter.js';
import { ReportJobPayloadError } from '../../src/reports/report-job-payload.js';
import { reportArtifactObjectKey } from '../../src/reports/report-run-snapshot.js';
import { ReportMissingRateError } from '../../src/reports/report.port.js';

describe('PostgresReportAdapter report-run queries', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';
  const asOf = new Date('2026-09-15T12:00:00.000Z');

  function clientWithRows(rows: readonly Record<string, unknown>[]) {
    const query = vi.fn().mockResolvedValue({ rows });
    return { client: { query } as unknown as TransactionClient, query };
  }

  const sourceRow = {
    transactionId: 'bbbbbbbb-0000-4000-8000-000000000001',
    occurredAt: '2026-09-05T00:00:00.000Z',
    type: 'expense',
    status: 'confirmed',
    amountMinor: '1000',
    currency: 'EUR',
    rate: '1.10',
    accountId: 'cccccccc-0000-4000-8000-000000000001',
    accountType: 'checking',
    categoryId: null,
    tags: [],
    payee: null,
    memberId: 'dddddddd-0000-4000-8000-000000000001',
    baseCurrency: 'USD',
  };

  it('STRUCTURAL: verifies SQL query structure for source row selection', async () => {
    const { client, query } = clientWithRows([]);
    await new PostgresReportAdapter().readReportSourceRows(
      client,
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      asOf,
      'expense',
    );

    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    // STRUCTURAL assertion, deliberately not behavioural. Row-level security is the
    // enforcing layer for cross-workspace reads: the policy gates SELECT,
    // and behavioural guarantees are provided by test/reports/report-runs.integration-spec.ts.
    // The predicate is defence in depth, and pinning its text is the only way to keep it.
    expect(sql).toContain('where t.workspace_id = $1::uuid');
    expect(sql).toContain("and t.status in ('confirmed', 'reconciled')");
    expect(sql).toContain('and exists (');
    expect(sql).toContain(
      "p1.status in ('confirmed', 'reconciled') and p1.transfer_id is null",
    );
    expect(sql).toContain('and not exists (');
    expect(sql).toContain("p2.status not in ('confirmed', 'reconciled')");
    expect(sql).not.toMatch(/\bnow\s*\(\s*\)/i);
    expect(sql).not.toMatch(/\bcurrent_date\b/i);
    expect(sql).toMatch(/effective_at\s*<=\s*\$5::timestamptz/);
    expect(values).toEqual([
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      'expense',
      '2026-09-15T12:00:00.000Z',
      50001,
    ]);
  });

  it('rejects a non-base row when its exchange rate is missing', async () => {
    const { client } = clientWithRows([{ ...sourceRow, rate: null }]);

    await expect(
      new PostgresReportAdapter().readReportSourceRows(
        client,
        workspaceId,
        '2026-01-01',
        '2026-09-05',
        asOf,
      ),
    ).rejects.toEqual(new ReportMissingRateError('EUR', 'USD'));
  });

  it('STRUCTURAL: verifies parameter binding for intersected type filter', async () => {
    const { client, query } = clientWithRows([]);
    await new PostgresReportAdapter().readReportSourceRows(
      client,
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      asOf,
      'expense',
      'income',
    );

    const [, values] = query.mock.calls[0] as [string, readonly unknown[]];
    // STRUCTURAL assertion, deliberately not behavioural. Behavioural filter intersection
    // is verified by test/reports/report-runs.integration-spec.ts. This test ensures the
    // adapter query passes the intersected parameter to the SQL driver.
    expect(values?.[3]).toEqual([]);
  });

  it('converts non-base rows using the selected rate', async () => {
    const { client } = clientWithRows([sourceRow]);
    const rows = await new PostgresReportAdapter().readReportSourceRows(
      client,
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      asOf,
    );

    expect(rows[0]?.convertedMinor).toBe(1100n);
  });

  it('STRUCTURAL: reads the job_id and status binding for a report run', async () => {
    const reportRunId = 'eeeeeeee-0000-4000-8000-000000000001';
    const { client, query } = clientWithRows([
      { jobId: 'aaaaaaaa-0000-4000-8000-000000000099', status: 'queued' },
    ]);
    const binding = await new PostgresReportAdapter().readReportRunBinding(
      client,
      workspaceId,
      reportRunId,
    );
    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toMatch(/select\s+job_id::text as "jobId", status/i);
    expect(sql).toMatch(
      /from public\.report_runs\s+where workspace_id = \$1::uuid\s+and id = \$2::uuid/,
    );
    expect(values).toEqual([workspaceId, reportRunId]);
    expect(binding).toEqual({
      jobId: 'aaaaaaaa-0000-4000-8000-000000000099',
      status: 'queued',
    });
  });

  it('STRUCTURAL: verifies SQL workspace scoping clause for report-run lookup', async () => {
    const { client, query } = clientWithRows([]);
    await new PostgresReportAdapter().findReportRun(
      client,
      workspaceId,
      'eeeeeeee-0000-4000-8000-000000000001',
    );

    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    // STRUCTURAL assertion, deliberately not behavioural. Row-level security is the
    // enforcing layer for cross-workspace reads: the policy on public.report_runs gates
    // SELECT on workspace_actor_active_role(workspace_id), so removing this predicate
    // from the query changes NO observable behaviour and no integration test can detect
    // it. The predicate is defence in depth, and pinning its text is the only way to
    // keep it. Rewriting the query is expected to update this string.
    expect(sql).toContain(
      'from public.report_runs where workspace_id = $1::uuid and id = $2::uuid',
    );
    expect(values).toEqual([
      workspaceId,
      'eeeeeeee-0000-4000-8000-000000000001',
    ]);
  });

  it('stores the deterministic object key computed at request time', async () => {
    const reportRunId = 'eeeeeeee-0000-4000-8000-000000000001';
    const { client, query } = clientWithRows([
      {
        id: reportRunId,
        definitionId: null,
        preset: 'expenses',
        status: 'completed',
        format: 'json',
        snapshotId: 'ffffffff-0000-4000-8000-000000000001',
        downloadUrl: 'https://storage.example.test/report.json',
        expiresAt: '2026-09-22T00:00:00.000000Z',
        createdAt: '2026-09-15T00:00:00.000000Z',
      },
    ]);
    await new PostgresReportAdapter().insertQueuedReportRun(
      client,
      workspaceId,
      subject,
      {
        id: reportRunId,
        definitionId: null,
        preset: 'expenses',
        format: 'json',
        filters: {},
        snapshotId: 'ffffffff-0000-4000-8000-000000000001',
        jobId: 'aaaaaaaa-0000-4000-8000-000000000099',
      },
    );

    const [, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(values).toContain(
      reportArtifactObjectKey(workspaceId, reportRunId, 'json'),
    );
  });

  it('does not rewrite a completed artifact when persist is guarded by processing status', async () => {
    const reportRunId = 'eeeeeeee-0000-4000-8000-000000000001';
    const originalUrl = 'https://storage.example.test/original.json';
    const row = {
      id: reportRunId,
      definitionId: null,
      preset: 'expenses',
      status: 'completed',
      format: 'json',
      snapshotId: 'ffffffff-0000-4000-8000-000000000001',
      downloadUrl: originalUrl,
      expiresAt: '2026-09-22T00:00:00.000000Z',
      createdAt: '2026-09-15T00:00:00.000000Z',
    };
    const query = vi.fn(async (sql: string) => {
      const guarded = /status\s*=\s*'processing'/.test(sql);
      if (/update\s+public\.report_runs/i.test(sql) && !guarded) {
        row.downloadUrl = 'https://storage.example.test/rewritten.json';
        row.status = 'completed';
        return { rows: [row] };
      }
      if (
        /update\s+public\.report_runs/i.test(sql) &&
        row.status !== 'processing'
      ) {
        return { rows: [] };
      }
      return { rows: [row] };
    });
    const client = { query } as unknown as TransactionClient;

    await expect(
      new PostgresReportAdapter().completeProcessingReportRun(
        client,
        workspaceId,
        reportRunId,
        'aaaaaaaa-0000-4000-8000-000000000099',
        {
          downloadUrl: 'https://storage.example.test/rewritten.json',
          expiresAt: new Date('2026-09-22T00:00:00.000Z'),
          completedAt: new Date('2026-09-15T12:00:00.000Z'),
        },
      ),
    ).rejects.toThrow(/processing/);
    expect(row.downloadUrl).toBe(originalUrl);
  });

  it('STRUCTURAL: persist completes only rows still processing', async () => {
    const { client, query } = clientWithRows([
      {
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        definitionId: null,
        preset: 'expenses',
        status: 'completed',
        format: 'json',
        snapshotId: 'ffffffff-0000-4000-8000-000000000001',
        downloadUrl: 'https://storage.example.test/report.json',
        expiresAt: '2026-09-22T00:00:00.000000Z',
        createdAt: '2026-09-15T00:00:00.000000Z',
      },
    ]);
    await new PostgresReportAdapter().completeProcessingReportRun(
      client,
      workspaceId,
      'eeeeeeee-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000099',
      {
        downloadUrl: 'https://storage.example.test/report.json',
        expiresAt: new Date('2026-09-22T00:00:00.000Z'),
        completedAt: new Date('2026-09-15T12:00:00.000Z'),
      },
    );
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/where[\s\S]*status\s*=\s*'processing'/);
    expect(sql).toMatch(/job_id\s*=\s*\$6::uuid/);
  });

  it('STRUCTURAL: begin processing requires the linked job_id', async () => {
    const reportRunId = 'eeeeeeee-0000-4000-8000-000000000001';
    const jobId = 'aaaaaaaa-0000-4000-8000-000000000099';
    const { client, query } = clientWithRows([{ id: reportRunId }]);
    await new PostgresReportAdapter().beginProcessingReportRun(
      client,
      workspaceId,
      reportRunId,
      jobId,
    );
    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toMatch(/job_id\s*=\s*\$3::uuid/);
    expect(values).toEqual([workspaceId, reportRunId, jobId]);
  });

  it('refuses to process a run linked to a different job', async () => {
    const query = vi.fn(async (sql: string) => {
      if (/update\s+public\.report_runs/i.test(sql)) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            jobId: 'aaaaaaaa-0000-4000-8000-000000000098',
            status: 'queued',
          },
        ],
      };
    });
    await expect(
      new PostgresReportAdapter().beginProcessingReportRun(
        { query } as unknown as TransactionClient,
        workspaceId,
        'eeeeeeee-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000099',
      ),
    ).rejects.toBeInstanceOf(ReportJobPayloadError);
  });
});
