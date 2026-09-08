import { describe, expect, it, vi } from 'vitest';
import { PostgresMcpGrantAdapter } from '../../src/mcp/postgres-mcp-grant.adapter.js';
describe('PostgresMcpGrantAdapter', () => {
  it('uses a subject-bound total-order cursor query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await new PostgresMcpGrantAdapter().list(
      { query } as never,
      '11111111-1111-4111-8111-111111111111',
      2,
      {
        createdAt: '2026-01-01T00:00:00.000000Z',
        id: '11111111-1111-4111-8111-111111111111',
      },
    );
    expect(query.mock.calls[0][0]).toContain('(created_at, id) >');
    expect(query.mock.calls[0][0]).toContain('order by created_at, id');
  });
});
