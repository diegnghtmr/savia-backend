import { describe, expect, it, vi } from 'vitest';
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
    reserveIdempotency: vi.fn(async () => true),
    finalizeIdempotency: vi.fn(async () => undefined),
    releaseIdempotency: vi.fn(async () => undefined),
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
    '44444444-4444-4444-8444-444444444444',
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
    '55555555-5555-4555-8555-555555555555',
    { message: 'x', modelRef: null, credentialId: null },
    new AbortController().signal,
    (event) => events.push(event),
  );
  expect(events.map((event) => event.type)).toEqual([
    'run_started',
    'run_completed',
  ]);
});

describe('in-flight idempotency', () => {
  it('allows only one overlapping request for the same key', async () => {
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerRuns = 0;
    const provider: AgentProviderPort = {
      stream: async function* () {
        providerRuns++;
        await providerStarted;
        yield { type: 'text_delta', data: { text: 'slow' } };
      },
    };
    let reserved = false;
    const service = new AgentMessageService(
      new Tx(),
      store({
        reserveIdempotency: vi.fn(async () => {
          if (reserved) return false;
          reserved = true;
          return true;
        }),
        readIdempotency: vi.fn(async () =>
          reserved
            ? {
                fingerprint: 'not-the-fingerprint',
                runId: '77777777-7777-4777-8777-777777777777',
                events: [],
              }
            : undefined,
        ),
      }),
      provider,
    );
    const command = { message: 'x', modelRef: null, credentialId: null };
    const firstOutcome = await service.prepare(
      subject,
      workspace,
      conversation,
      'same-key',
      command,
    );
    const firstExecution = service.execute(
      subject,
      workspace,
      conversation,
      'same-key',
      firstOutcome.kind === 'ready'
        ? firstOutcome.runId
        : '66666666-6666-4666-8666-666666666666',
      command,
      new AbortController().signal,
      () => undefined,
    );
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (providerRuns === 1) resolve();
        else setTimeout(poll, 0);
      };
      poll();
    });
    const secondOutcome = await service.prepare(
      subject,
      workspace,
      conversation,
      'same-key',
      command,
    );
    expect([firstOutcome.kind, secondOutcome.kind].sort()).toEqual([
      'conflict',
      'ready',
    ]);
    expect(providerRuns).toBe(1);
    releaseProvider();
    await firstExecution;
  });

  it('closes a slow provider iterator and releases its reservation on abort', async () => {
    const controller = new AbortController();
    let closed = false;
    const provider: AgentProviderPort = {
      stream: async function* (_command, signal) {
        void _command;
        try {
          yield { type: 'text_delta', data: { text: 'before abort' } };
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          yield { type: 'text_delta', data: { text: 'never emitted' } };
        } finally {
          closed = true;
        }
      },
    };
    const releaseIdempotency = vi.fn(async () => undefined);
    const events: string[] = [];
    const service = new AgentMessageService(
      new Tx(),
      store({ releaseIdempotency }),
      provider,
    );
    const execution = service.execute(
      subject,
      workspace,
      conversation,
      'abort-key',
      '88888888-8888-4888-8888-888888888888',
      { message: 'x', modelRef: null, credentialId: null },
      controller.signal,
      (event) => events.push(event.type),
    );
    await vi.waitFor(() => expect(events).toEqual(['run_started', 'text_delta']));
    controller.abort();
    await execution;
    expect(closed).toBe(true);
    expect(releaseIdempotency).toHaveBeenCalledOnce();
    expect(events).not.toContain('run_completed');
  });
});
