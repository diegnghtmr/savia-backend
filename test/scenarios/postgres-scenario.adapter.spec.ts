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
});
