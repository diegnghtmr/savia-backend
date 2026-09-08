import { describe, expect, it, vi } from 'vitest';
import { PostgresAgentConversationAdapter } from '../../src/agent/postgres-agent-conversation.adapter.js';
describe('PostgresAgentConversationAdapter', () => {
  it('uses workspace, created_at and id in pagination', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PostgresAgentConversationAdapter().list(
      { query } as never,
      '33333333-3333-4333-8333-333333333333',
      2,
      {
        createdAt: '2026-01-01T00:00:00.000000Z',
        id: '11111111-1111-4111-8111-111111111111',
      },
    );
    const calls = query.mock.calls as unknown as unknown[][];
    const sql = String(calls[0]?.[0]);
    expect(sql).toContain('where workspace_id=$1::uuid');
    expect(sql).toContain('(created_at,id)>($2::timestamptz,$3::uuid)');
    expect(sql).toContain('order by created_at,id');
    expect(calls[0]?.[1]).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '2026-01-01T00:00:00.000000Z',
      '11111111-1111-4111-8111-111111111111',
      2,
    ]);
  });

  it('applies workspace scoping and total ordering without a cursor', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PostgresAgentConversationAdapter().list({ query } as never, 'workspace', 3);
    const calls = query.mock.calls as unknown as unknown[][];
    const [sql, values] = calls[0] ?? [];
    expect(String(sql)).toContain('where workspace_id=$1::uuid');
    expect(String(sql)).toContain('order by created_at,id');
    expect(values).toEqual(['workspace', 3]);
  });

  it('maps node-pg timestamptz Date values to contract strings', async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: 'id', title: 'title', modelRef: null,
          createdAt: new Date('2026-01-01T00:00:00.123Z'),
          updatedAt: new Date('2026-01-01T00:00:00.456Z'),
        },
      ],
    }));
    const [row] = await new PostgresAgentConversationAdapter().list(
      { query } as never, 'workspace', 1,
    );
    expect(row).toMatchObject({
      createdAt: '2026-01-01T00:00:00.123000Z',
      updatedAt: '2026-01-01T00:00:00.456000Z',
    });
  });
});
