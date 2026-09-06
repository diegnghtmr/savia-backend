import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresReportAdapter } from '../../src/reports/postgres-report.adapter.js';
import { ReportMissingRateError } from '../../src/reports/report.port.js';

describe('PostgresReportAdapter report-run queries', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';

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

  it('keeps workspace scope and both independent posting predicates', async () => {
    const { client, query } = clientWithRows([]);
    await new PostgresReportAdapter().readReportSourceRows(
      client,
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      'expense',
    );

    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain('where t.workspace_id = $1::uuid');
    expect(sql).toContain("and t.status in ('confirmed', 'reconciled')");
    expect(sql).toContain('and exists (');
    expect(sql).toContain(
      "p1.status in ('confirmed', 'reconciled') and p1.transfer_id is null",
    );
    expect(sql).toContain('and not exists (');
    expect(sql).toContain("p2.status not in ('confirmed', 'reconciled')");
    expect(values).toEqual([
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      'expense',
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
      ),
    ).rejects.toEqual(new ReportMissingRateError('EUR', 'USD'));
  });

  it('intersects preset and caller type filters instead of widening the preset', async () => {
    const { client, query } = clientWithRows([]);
    await new PostgresReportAdapter().readReportSourceRows(
      client,
      workspaceId,
      '2026-01-01',
      '2026-09-05',
      'expense',
      'income',
    );

    const [, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(values?.[3]).toEqual([]);
  });

  it('converts non-base rows using the selected rate', async () => {
    const { client } = clientWithRows([sourceRow]);
    const rows = await new PostgresReportAdapter().readReportSourceRows(
      client,
      workspaceId,
      '2026-01-01',
      '2026-09-05',
    );

    expect(rows[0]?.convertedMinor).toBe(1100n);
  });

  it('scopes report-run lookup by workspace for dual members', async () => {
    const { client, query } = clientWithRows([]);
    await new PostgresReportAdapter().findReportRun(
      client,
      workspaceId,
      'eeeeeeee-0000-4000-8000-000000000001',
    );

    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain(
      'from public.report_runs where workspace_id = $1::uuid and id = $2::uuid',
    );
    expect(values).toEqual([
      workspaceId,
      'eeeeeeee-0000-4000-8000-000000000001',
    ]);
  });
});
