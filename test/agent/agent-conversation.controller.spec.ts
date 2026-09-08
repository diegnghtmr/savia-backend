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
  it('maps create outcomes', async () => {
    const p = {
      createAgentConversation: vi.fn(async () => ({
        kind: 'created',
        conversation: { id: 'x' },
      })),
      listAgentConversations: vi.fn(),
    };
    const r = new Reply();
    await new AgentConversationsController(p as never).create(
      request,
      {},
      r as never,
    );
    expect(r.statusCode).toBe(201);
  });
  it('maps invalid credential to 422', async () => {
    const p = {
      createAgentConversation: vi.fn(async () => ({ kind: 'invalid' })),
      listAgentConversations: vi.fn(),
    };
    const r = new Reply();
    await new AgentConversationsController(p as never).create(
      request,
      {},
      r as never,
    );
    expect(r.statusCode).toBe(422);
  });
});
