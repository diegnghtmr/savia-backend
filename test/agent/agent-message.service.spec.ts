import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgentMessagesController } from '../../src/agent/agent-messages.controller.js';
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

describe('tool rounds', () => {
  async function run(
    name: string,
    args: Record<string, unknown>,
    repeat = false,
    result: unknown = ['account'],
  ) {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const listAccounts = vi.fn(async () => result);
    const validateTransaction = vi.fn(() => null);
    const validateTransfer = vi.fn(() => ({
      sourceAccountId: workspace,
      destinationAccountId: conversation,
      amount: { amountMinor: '25', currency: 'USD' },
      occurredAt: '2026-01-02T00:00:00.000Z',
    }));
    const canUseAccount = vi.fn(async () => true);
    const createApproval = vi.fn(async () => 'approval');
    let turns = 0;
    const stream = vi.fn<AgentProviderPort['stream']>(async function* () {
      if (turns++ === 0 || repeat) {
        yield {
          type: 'tool_calls',
          data: { calls: [{ id: 'call_1', name, arguments: args }] },
        };
      } else {
        yield { type: 'text_delta', data: { text: 'Done' } };
      }
    });
    await new AgentMessageService(
      new Tx(),
      store(),
      { stream },
      {
        listAccounts,
        listRecentTransactions: vi.fn(),
        validateTransaction,
        validateTransfer,
        canUseAccount,
        createApproval,
      },
    ).execute(
      subject,
      workspace,
      conversation,
      'key',
      conversation,
      { message: 'x', modelRef: null, credentialId: null },
      new AbortController().signal,
      ({ type, data }) => events.push({ type, data }),
    );
    return {
      stream,
      listAccounts,
      validateTransaction,
      validateTransfer,
      canUseAccount,
      createApproval,
      events,
    };
  }

  it('uses the run context and sends the read result as a tool message', async () => {
    const { stream, listAccounts, events } = await run('list_accounts', {});
    expect(listAccounts).toHaveBeenCalledExactlyOnceWith({
      subject,
      workspaceId: workspace,
    });
    expect(stream.mock.calls[0]?.[3]?.tools.map(({ name }) => name)).toEqual([
      'list_accounts',
      'list_recent_transactions',
      'create_transaction',
      'create_transfer',
    ]);
    expect(stream.mock.calls[1]?.[3]?.history?.at(-1)).toEqual({
      role: 'tool',
      callId: 'call_1',
      content: '["account"]',
    });
    expect(events).toEqual([
      { type: 'run_started', data: {} },
      {
        type: 'tool_proposed',
        data: {
          toolName: 'list_accounts',
          callId: 'call_1',
          requiresApproval: false,
        },
      },
      {
        type: 'tool_completed',
        data: { toolName: 'list_accounts', callId: 'call_1', ok: true },
      },
      { type: 'text_delta', data: { text: 'Done' } },
      { type: 'run_completed', data: {} },
    ]);
  });

  it.each([
    ['list_accounts', { workspaceId: conversation, subject: conversation }],
    [
      'create_transaction',
      {
        type: 'expense',
        accountId: workspace,
        amount: { amountMinor: 'invalid', currency: 'USD' },
        occurredAt: '2026-01-02T00:00:00Z',
      },
    ],
  ] as const)(
    'returns a tool error for invalid %s arguments without side effects',
    async (name, args) => {
      const {
        stream,
        listAccounts,
        validateTransaction,
        createApproval,
        events,
      } = await run(name, args);
      expect(stream.mock.calls[1]?.[3]?.history?.at(-1)).toEqual({
        role: 'tool',
        callId: 'call_1',
        content: '{"error":"Invalid tool arguments"}',
      });
      if (name === 'create_transaction')
        expect(validateTransaction).toHaveBeenCalledExactlyOnceWith(args);
      expect(listAccounts).not.toHaveBeenCalled();
      expect(createApproval).not.toHaveBeenCalled();
      expect(events.map(({ type }) => type)).toEqual([
        'run_started',
        'tool_proposed',
        'tool_completed',
        'text_delta',
        'run_completed',
      ]);
      expect(events[2]?.data).toEqual({
        toolName: name,
        callId: 'call_1',
        ok: false,
      });
    },
  );

  // The ledger does not record a transfer fee or description, so the tool must not accept them.
  it.each([
    'valid',
    'wrong type',
    'missing field',
    'extra field',
    'fee field',
    'description field',
  ] as const)('handles a %s transfer proposal', async (mode) => {
    const input = {
      sourceAccountId: workspace,
      ...(mode !== 'missing field' && { destinationAccountId: conversation }),
      amount: {
        amountMinor: mode === 'wrong type' ? 25 : '25',
        currency: 'USD',
      },
      occurredAt: '2026-01-02T00:00:00Z',
      ...(mode === 'extra field' && { workspaceId: conversation }),
      ...(mode === 'fee field' && {
        fee: { amountMinor: '5', currency: 'USD' },
      }),
      ...(mode === 'description field' && { description: 'Rent' }),
    };
    const { stream, validateTransfer, canUseAccount, createApproval, events } =
      await run('create_transfer', input);
    if (mode !== 'valid') {
      expect(stream.mock.calls[1]?.[3]?.history?.at(-1)).toMatchObject({
        role: 'tool',
        content: '{"error":"Invalid tool arguments"}',
      });
      expect(validateTransfer).not.toHaveBeenCalled();
      expect(canUseAccount).not.toHaveBeenCalled();
      expect(createApproval).not.toHaveBeenCalled();
      return;
    }
    expect(validateTransfer).toHaveBeenCalledExactlyOnceWith(input);
    expect(canUseAccount.mock.calls).toEqual([
      [{ subject, workspaceId: workspace }, workspace],
      [{ subject, workspaceId: workspace }, conversation],
    ]);
    expect(createApproval).toHaveBeenCalledExactlyOnceWith(
      { subject, workspaceId: workspace },
      expect.objectContaining({
        toolName: 'create_transfer',
        channel: 'agent',
        riskClass: 'financial_write',
        preview: expect.objectContaining({
          sourceAccountId: workspace,
          destinationAccountId: conversation,
          amount: '25',
          currency: 'USD',
        }),
      }),
    );
    expect(stream).toHaveBeenCalledOnce();
    expect(events.at(-2)).toEqual({
      type: 'approval_required',
      data: {
        toolName: 'create_transfer',
        callId: 'call_1',
        approvalId: 'approval',
      },
    });
  });

  it('refuses to dispatch a fifth round', async () => {
    const { stream, listAccounts, events } = await run(
      'list_accounts',
      {},
      true,
    );
    expect(stream).toHaveBeenCalledTimes(5);
    expect(listAccounts).toHaveBeenCalledTimes(4);
    expect(events.at(-1)).toEqual({
      type: 'run_failed',
      data: { message: 'Tool round limit reached' },
    });
  });

  it('does not send an over-budget result back to the provider', async () => {
    const { stream, listAccounts, events } = await run(
      'list_accounts',
      {},
      false,
      'é'.repeat(32768),
    );
    expect(stream).toHaveBeenCalledOnce();
    expect(listAccounts).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({
      type: 'run_failed',
      data: { message: 'Tool result size limit reached' },
    });
  });
});

describe('in-flight idempotency', () => {
  it('does not start the provider or write SSE when the client closes during prepare', async () => {
    const reserved = Promise.withResolvers<void>();
    const finishPrepare = Promise.withResolvers<boolean>();
    const repository = store({
      reserveIdempotency: vi.fn(() => {
        reserved.resolve();
        return finishPrepare.promise;
      }),
    });
    const stream = vi.fn(async function* () {});
    const service = new AgentMessageService(new Tx(), repository, { stream });
    const controller = new AgentMessagesController(service);
    const raw = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    });
    const hijack = vi.fn();
    const key = '99999999-9999-4999-8999-999999999999';
    const request = controller.send(
      {
        headers: { 'x-workspace-id': workspace, 'idempotency-key': key },
        identity: { subject },
      } as never,
      conversation,
      { message: 'synthetic prompt' },
      { hijack, raw } as never,
    );
    await reserved.promise;
    raw.emit('close');
    finishPrepare.resolve(true);
    await request;
    expect(stream).not.toHaveBeenCalled();
    expect(hijack).not.toHaveBeenCalled();
    expect(raw.writeHead).not.toHaveBeenCalled();
    expect(raw.write).not.toHaveBeenCalled();
    expect(raw.end).not.toHaveBeenCalled();
    expect(repository.saveRun).not.toHaveBeenCalled();
    expect(repository.finalizeIdempotency).not.toHaveBeenCalled();
    expect(repository.releaseIdempotency).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      subject,
      workspace,
      conversation,
      key,
    );
  });
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
          signal.throwIfAborted();
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
    await vi.waitFor(() =>
      expect(events).toEqual(['run_started', 'text_delta']),
    );
    controller.abort();
    await execution;
    expect(closed).toBe(true);
    expect(releaseIdempotency).toHaveBeenCalledOnce();
    expect(events).toEqual(['run_started', 'text_delta']);
  });
});
