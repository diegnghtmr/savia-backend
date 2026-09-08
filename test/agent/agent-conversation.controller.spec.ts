import { describe, expect, it, vi } from 'vitest';
import { AgentConversationsController } from '../../src/agent/agent-conversations.controller.js';
class Reply {
  statusCode = 200;
  body: unknown;
  request = { id: 'trace', url: '/v1/agent/conversations' };
  status(n: number) {
    this.statusCode = n;
    return this;
  }
  type() {
    return this;
  }
  send(b?: unknown) {
    this.body = b;
    return this;
  }
}
const request = {
  headers: {
    'x-workspace-id': '33333333-3333-4333-8333-333333333333',
    'idempotency-key': '44444444-4444-4444-8444-444444444444',
  },
  identity: { subject: '11111111-1111-4111-8111-111111111111' },
} as never;
describe('AgentConversationsController', () => {
  it('maps every create outcome to its declared status and problem details', async () => {
    const outcomes = [
      ['created', 201],
      ['forbidden', 403],
      ['invalid', 422],
      ['conflict', 409],
    ] as const;
    for (const [kind, status] of outcomes) {
      const p = {
        createAgentConversation: vi.fn(async () =>
          kind === 'created'
            ? { kind, conversation: { id: 'x' } }
            : { kind },
        ),
        listAgentConversations: vi.fn(),
      };
      const r = new Reply();
      await new AgentConversationsController(p as never).create(request, {}, r as never);
      expect(r.statusCode).toBe(status);
      if (status !== 201)
        expect(r.body).toEqual(expect.objectContaining({ status, type: expect.any(String) }));
    }
  });

  it('maps list success and forbidden outcomes to 200 and 403', async () => {
    const p = {
      createAgentConversation: vi.fn(),
      listAgentConversations: vi.fn(async (): Promise<unknown> => ({
        kind: 'ok',
        page: { items: [], pageInfo: { hasNextPage: false, nextCursor: null } },
      })),
    };
    const r = new Reply();
    await new AgentConversationsController(p as never).list(request, r as never);
    expect(r.statusCode).toBe(200);
    p.listAgentConversations.mockResolvedValue({ kind: 'forbidden' });
    const forbidden = new Reply();
    await new AgentConversationsController(p as never).list(request, forbidden as never);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).toEqual(expect.objectContaining({ status: 403 }));
  });
});
