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
    expect(sql).toContain('(created_at,id)>');
    expect(sql).toContain('order by created_at,id');
  });
});
