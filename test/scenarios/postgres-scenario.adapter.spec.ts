import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresScenarioAdapter } from '../../src/scenarios/postgres-scenario.adapter.js';

describe('PostgresScenarioAdapter', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';

  it('reads active role for workspace', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ role: 'owner' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const role = await adapter.readActiveRole(mockClient, workspaceId);

    expect(role).toBe('owner');
    // STRUCTURAL assertion, deliberately not behavioural. Pinning the call to
    // workspace_actor_active_role verifies the adapter queries active role membership
    // via the PostgreSQL RLS helper. A harmless query rewrite is expected to update this string.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('workspace_actor_active_role'),
      [workspaceId],
    );
  });

  it('creates scenario with jsonb assumptions and null description when omitted', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'cccccccc-0000-4000-8000-000000000001',
            name: 'Test',
            description: null,
            assumptions: [{ type: 'income_change', value: {} }],
            lastRunId: null,
            createdAt: '2026-09-04T12:00:00.000000Z',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const scenario = await adapter.createScenario(
      mockClient,
      workspaceId,
      subject,
      {
        name: 'Test',
        assumptions: [{ type: 'income_change', value: {} }],
      },
    );

    expect(scenario.id).toBe('cccccccc-0000-4000-8000-000000000001');
    expect(scenario.description).toBeNull();
    expect(scenario.lastRunId).toBeNull();
    // STRUCTURAL assertion, deliberately not behavioural. It pins the insert statement
    // structure and target table public.scenarios against the mocked client; a harmless
    // query rewrite is expected to update this string.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/insert into public\.scenarios/i),
      [
        workspaceId,
        'Test',
        null,
        JSON.stringify([{ type: 'income_change', value: {} }]),
        subject,
      ],
    );
  });

  it('lists scenarios ordered by created_at asc, id asc', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'cccccccc-0000-4000-8000-000000000001',
            name: 'Test 1',
            description: 'Desc',
            assumptions: [{ type: 'purchase', value: {} }],
            lastRunId: null,
            createdAt: '2026-09-04T12:00:00.000000Z',
            cursorAt: '2026-09-04T12:00:00.000000Z',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const items = await adapter.listScenarios(
      mockClient,
      { workspaceId, limit: 10 },
      11,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.cursorAt).toBe('2026-09-04T12:00:00.000000Z');
    expect(items[0]?.scenario.lastRunId).toBeNull();

    const [sql, values] = (mockClient.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
    // STRUCTURAL assertion, deliberately not behavioural. Row-level security is the
    // enforcing layer for cross-workspace reads: the policy on public.scenarios gates
    // SELECT on workspace_actor_active_role(workspace_id), so removing this predicate
    // from the query changes NO observable behaviour and no integration test can detect
    // it. The predicate is defence in depth, and pinning its text is the only way to
    // keep it. Rewriting the query is expected to update this string.
    expect(sql).toContain('workspace_id = $1::uuid');
    expect(sql).toMatch(/order by.*created_at asc.*id asc/i);
    expect(values).toEqual([workspaceId, null, null, 11]);
  });

  it('reads workspace base currency', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ baseCurrency: 'USD' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const curr = await adapter.readWorkspaceBaseCurrency(
      mockClient,
      workspaceId,
    );
    expect(curr).toBe('USD');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('select base_currency'),
      [workspaceId],
    );
  });

  it('reads account native balances filtering confirmed/reconciled', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'acct-1',
            currency: 'USD',
            nativeBalanceMinor: '150000',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const balances = await adapter.readAccountNativeBalances(
      mockClient,
      workspaceId,
    );
    expect(balances).toHaveLength(1);
    expect(balances[0]?.nativeBalanceMinor).toBe('150000');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("acct.status <> 'closed'"),
      [workspaceId],
    );
  });

  it('reads debt outstanding balances', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'debt-1',
            currency: 'USD',
            outstandingBalanceMinor: '50000',
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const balances = await adapter.readDebtOutstandingBalances(
      mockClient,
      workspaceId,
    );
    expect(balances).toHaveLength(1);
    expect(balances[0]?.outstandingBalanceMinor).toBe('50000');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("d.status <> 'archived'"),
      [workspaceId],
    );
  });

  it('reads transactions in period with posting status checks', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'txn-1',
            type: 'income',
            amountMinor: '300000',
            currency: 'USD',
            occurredAt: new Date('2026-08-15T12:00:00Z'),
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const rows = await adapter.readTransactionsInPeriod(
      mockClient,
      workspaceId,
      '2025-10-01',
      '2026-09-04',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountMinor).toBe('300000');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("t.status in ('confirmed', 'reconciled')"),
      [workspaceId, '2025-10-01', '2026-09-04'],
    );
  });

  it('finds exchange rate using shared query', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ rate: '1.25' }],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const asOf = new Date('2026-09-04T00:00:00Z');
    const rate = await adapter.findExchangeRate(
      mockClient,
      workspaceId,
      'EUR',
      'USD',
      asOf,
    );
    expect(rate).toBe('1.25');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('select rate::text as rate'),
      [workspaceId, 'EUR', 'USD', asOf],
    );
  });

  it('creates scenario run and returns ScenarioRun record', async () => {
    const scenarioId = 'cccccccc-0000-4000-8000-000000000001';
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'run-1',
            scenarioId,
            status: 'completed',
            baseline: {
              periodStart: '2025-10-01',
              periodEnd: '2026-09-04',
              baseCurrency: 'USD',
              monthlyIncomeMinor: '300000',
              monthlyExpensesMinor: '200000',
              monthlySavingsCapacityMinor: '100000',
              netWorthMinor: '1000000',
            },
            projected: {
              periodStart: '2025-10-01',
              periodEnd: '2026-09-04',
              baseCurrency: 'USD',
              monthlyIncomeMinor: '350000',
              monthlyExpensesMinor: '200000',
              monthlySavingsCapacityMinor: '150000',
              netWorthMinor: '1000000',
            },
            difference: {
              periodStart: '2025-10-01',
              periodEnd: '2026-09-04',
              baseCurrency: 'USD',
              monthlyIncomeMinor: '50000',
              monthlyExpensesMinor: '0',
              monthlySavingsCapacityMinor: '50000',
              netWorthMinor: '0',
            },
            risks: [],
          },
        ],
      }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    const run = await adapter.createScenarioRun(
      mockClient,
      workspaceId,
      scenarioId,
      subject,
      {
        status: 'completed',
        baseline: {
          periodStart: '2025-10-01',
          periodEnd: '2026-09-04',
          baseCurrency: 'USD',
          monthlyIncomeMinor: '300000',
          monthlyExpensesMinor: '200000',
          monthlySavingsCapacityMinor: '100000',
          netWorthMinor: '1000000',
        },
        projected: {
          periodStart: '2025-10-01',
          periodEnd: '2026-09-04',
          baseCurrency: 'USD',
          monthlyIncomeMinor: '350000',
          monthlyExpensesMinor: '200000',
          monthlySavingsCapacityMinor: '150000',
          netWorthMinor: '1000000',
        },
        difference: {
          periodStart: '2025-10-01',
          periodEnd: '2026-09-04',
          baseCurrency: 'USD',
          monthlyIncomeMinor: '50000',
          monthlyExpensesMinor: '0',
          monthlySavingsCapacityMinor: '50000',
          netWorthMinor: '0',
        },
        risks: [],
      },
    );

    expect(run.id).toBe('run-1');
    expect(run.scenarioId).toBe(scenarioId);
    expect(run.status).toBe('completed');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(/insert into public\.scenario_runs/i),
      expect.arrayContaining([workspaceId, scenarioId, 'completed', subject]),
    );
  });

  it('updates scenario last_run_id', async () => {
    const scenarioId = 'cccccccc-0000-4000-8000-000000000001';
    const runId = 'run-1';
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    } as unknown as TransactionClient;

    const adapter = new PostgresScenarioAdapter();
    await adapter.updateScenarioLastRunId(
      mockClient,
      workspaceId,
      scenarioId,
      runId,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /update public\.scenarios\s+set last_run_id = \$3::uuid/i,
      ),
      [workspaceId, scenarioId, runId],
    );
  });
});
