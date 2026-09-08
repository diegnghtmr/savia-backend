import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyRecord, IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { AgentConversationService, type AgentConversationTransaction } from '../../src/agent/agent-conversation.service.js';

const conversation = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'x', modelRef: null,
  createdAt: '2026-01-01T00:00:00.000000Z',
  updatedAt: '2026-01-01T00:00:00.000000Z',
};
const subject = '11111111-1111-4111-8111-111111111111';
const workspace = '33333333-3333-4333-8333-333333333333';
const command = { title: 'x', modelRef: null, credentialId: null };

class RecordingTransaction implements AgentConversationTransaction {
  public committed = 0;
  public rolledBack = 0;
  private readonly client: TransactionClient = { query: async () => ({ rows: [] }) };

  public async run<T>(_subject: string, callback: (client: TransactionClient) => Promise<T>): Promise<T> {
    try {
      const result = await callback(this.client);
      this.committed++;
      return result;
    } catch (error) {
      this.rolledBack++;
      throw error;
    }
  }

  public async runRead<T>(_subject: string, callback: (client: TransactionClient) => Promise<T>): Promise<T> {
    return callback(this.client);
  }
}

function store(overrides: Record<string, unknown> = {}) {
  return {
    createId: vi.fn(() => conversation.id),
    hasActiveMembership: vi.fn(async () => true),
    credentialUsable: vi.fn(async () => true),
    create: vi.fn(async () => conversation),
    list: vi.fn(async () => [conversation]),
    ...overrides,
  };
}

function idempotency(overrides: Record<string, unknown> = {}): IdempotencyStore {
  return {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => true),
    ...overrides,
  } as unknown as IdempotencyStore;
}

describe('agent conversation service', () => {
  it('commits a successful create after recording idempotency', async () => {
    const tx = new RecordingTransaction();
    const idem = idempotency();
    const result = await new AgentConversationService(tx, store(), idem).createAgentConversation(subject, workspace, command, 'key');
    expect(result).toEqual({ kind: 'created', conversation });
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
    expect(idem.write).toHaveBeenCalledOnce();
  });

  it.each([
    ['idempotency write loses', false],
    ['idempotency write throws', new Error('write failed')],
  ])('rolls back when the post-write completion path %s', async (_name, writeResult) => {
    const tx = new RecordingTransaction();
    const write = vi.fn(async () => {
      if (writeResult instanceof Error) throw writeResult;
      return writeResult;
    });
    const operation = new AgentConversationService(tx, store(), idempotency({ write })).createAgentConversation(subject, workspace, command, 'key');
    if (writeResult instanceof Error) await expect(operation).rejects.toThrow('write failed');
    else expect(await operation).toEqual({ kind: 'conflict' });
    expect(tx.committed).toBe(0);
    expect(tx.rolledBack).toBe(1);
  });

  it('commits the credential-rejection outcome without writing an idempotency record', async () => {
    const tx = new RecordingTransaction();
    const write = vi.fn(async () => true);
    const result = await new AgentConversationService(
      tx,
      store({ credentialUsable: vi.fn(async () => false) }),
      idempotency({ write }),
    ).createAgentConversation(subject, workspace, { ...command, credentialId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, 'key');
    expect(result).toEqual({ kind: 'invalid' });
    expect(write).not.toHaveBeenCalled();
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
  });

  it('replays and conflicts by fingerprint inside the transaction', async () => {
    const record: IdempotencyRecord = {
      requestFingerprint: 'different', responseStatus: 201, responseEtag: null, responseBody: conversation,
    };
    const tx = new RecordingTransaction();
    const result = await new AgentConversationService(tx, store(), idempotency({ read: vi.fn(async () => record) })).createAgentConversation(subject, workspace, command, 'key');
    expect(result).toEqual({ kind: 'conflict' });
    expect(tx.committed).toBe(1);
    expect(tx.rolledBack).toBe(0);
  });

  it('paginates with a cursor tie-break and read transaction', async () => {
    const tx = new RecordingTransaction();
    const result = await new AgentConversationService(tx, store({ list: vi.fn(async () => [conversation, { ...conversation, id: '11111111-1111-4111-8111-111111111111' }]) }), idempotency()).listAgentConversations(subject, workspace, { limit: 1 });
    expect(result).toMatchObject({ kind: 'ok', page: { items: [conversation], pageInfo: { hasNextPage: true, nextCursor: expect.any(String) } } });
  });
});
