import { expect, it, vi } from 'vitest';
import { PostgresAgentMessageAdapter } from '../../src/agent/postgres-agent-message.adapter.js';
it('uses a database function for the shared rate-limit decision', async () => {
  const query = vi.fn(async () => ({ rows: [{ allowed: true }] }));
  expect(
    await new PostgresAgentMessageAdapter().consumeRateLimit(
      { query } as never,
      's',
      'w',
      'c',
      '2026-01-01T00:00:00.000Z',
    ),
  ).toBe(true);
  expect((query.mock.calls as unknown[][])[0]?.[0]).toContain(
    'consume_agent_message_rate_limit',
  );
});
