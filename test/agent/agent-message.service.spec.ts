import { expect, it, vi } from 'vitest';
import { AgentMessageService } from '../../src/agent/agent-message.service.js';
import type {
  AgentMessageStore,
  AgentProviderPort,
  AgentMessageTransaction,
} from '../../src/agent/agent-message.port.js';
const subject = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const conversation = '33333333-3333-4333-8333-333333333333';
class Tx implements AgentMessageTransaction {
  committed = 0;
  rolledBack = 0;
  async run<T>(_s: string, callback: (c: never) => Promise<T>): Promise<T> {
    try {
      const result = await callback({} as never);
      this.committed++;
      return result;
    } catch (e) {
      this.rolledBack++;
      throw e;
    }
  }
}
function store(overrides: Partial<AgentMessageStore> = {}): AgentMessageStore {
  return {
    conversationExists: vi.fn(async () => true),
    consumeRateLimit: vi.fn(async () => true),
    saveRun: vi.fn(async () => undefined),
    readRun: vi.fn(async () => undefined),
    saveIdempotency: vi.fn(async () => true),
    readIdempotency: vi.fn(async () => undefined),
    createId: vi.fn(() => conversation),
    ...overrides,
  };
}
it('prepares a run only for an existing conversation and rate-limit allowance', async () => {
  const tx = new Tx();
  const result = await new AgentMessageService(tx, store(), {
    stream: async function* () {},
  }).prepare(subject, workspace, conversation, 'key', {
    message: 'x',
    modelRef: null,
    credentialId: null,
  });
  expect(result.kind).toBe('ready');
  expect(tx.committed).toBe(1);
});
it('emits started, newline-safe text, and one terminal event', async () => {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const provider: AgentProviderPort = {
    stream: async function* () {
      yield { type: 'text_delta', data: { text: 'a\r\nb' } };
    },
  };
  await new AgentMessageService(new Tx(), store(), provider).execute(
    subject,
    workspace,
    conversation,
    'key',
    { message: 'x', modelRef: null, credentialId: null },
    new AbortController().signal,
    (event) => events.push(event),
  );
  expect(events.map((e) => e.type)).toEqual([
    'run_started',
    'text_delta',
    'run_completed',
  ]);
  expect(events.every((e) => e.data !== undefined)).toBe(true);
});

it('does not emit after a provider terminal event', async () => {
  const events: Array<{ type: string }> = [];
  const provider: AgentProviderPort = {
    stream: async function* () {
      yield { type: 'run_completed', data: {} } as never;
      yield { type: 'text_delta', data: { text: 'stray' } };
    },
  };
  await new AgentMessageService(new Tx(), store(), provider).execute(
    subject,
    workspace,
    conversation,
    'terminal-key',
    { message: 'x', modelRef: null, credentialId: null },
    new AbortController().signal,
    (event) => events.push(event),
  );
  expect(events.map((event) => event.type)).toEqual([
    'run_started',
    'run_completed',
  ]);
});
