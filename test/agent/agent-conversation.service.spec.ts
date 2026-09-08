import { describe, expect, it, vi } from 'vitest';
import { AgentConversationService } from '../../src/agent/agent-conversation.service.js';
import type { AgentConversationTransaction } from '../../src/agent/agent-conversation.service.js';
const conversation = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'x',
  modelRef: null,
  createdAt: '2026-01-01T00:00:00.000000Z',
  updatedAt: '2026-01-01T00:00:00.000000Z',
};
const tx = {
  run: vi.fn(async <T>(_s: string, cb: (c: never) => Promise<T>) =>
    cb({} as never),
  ),
  runRead: vi.fn(async <T>(_s: string, cb: (c: never) => Promise<T>) =>
    cb({} as never),
  ),
};
const transaction = tx as unknown as AgentConversationTransaction;
describe('agent conversation service', () => {
  it('creates and records idempotency', async () => {
    const store = {
      createId: vi.fn(() => conversation.id),
      hasActiveMembership: vi.fn(async () => true),
      credentialUsable: vi.fn(async () => true),
      create: vi.fn(async () => conversation),
      list: vi.fn(),
    };
    const idem = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => true),
    };
    const result = await new AgentConversationService(
      transaction,
      store as never,
      idem,
    ).createAgentConversation(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      { title: 'x', modelRef: null, credentialId: null },
      '44444444-4444-4444-8444-444444444444',
    );
    expect(result).toEqual({ kind: 'created', conversation });
    expect(idem.write).toHaveBeenCalled();
  });
  it('paginates with cursor tie-break', async () => {
    const store = {
      hasActiveMembership: vi.fn(async () => true),
      list: vi.fn(async () => [
        conversation,
        { ...conversation, id: '11111111-1111-4111-8111-111111111111' },
      ]),
    };
    const result = await new AgentConversationService(
      transaction,
      store as never,
      {} as never,
    ).listAgentConversations(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      { limit: 1 },
    );
    expect(result).toMatchObject({
      kind: 'ok',
      page: { items: [conversation], pageInfo: { hasNextPage: true } },
    });
  });
});
