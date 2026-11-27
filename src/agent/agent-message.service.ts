import { randomUUID } from 'node:crypto';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import { AgentProviderFailure } from './agent-provider.adapter.js';
import {
  AGENT_EVENT_TYPES,
  AGENT_MESSAGE_OUTCOMES,
  type AgentEvent,
  type AgentMessageCommand,
  type AgentMessageOutcome,
  type AgentMessagePort,
  type AgentMessageStore,
  type AgentMessageTransaction,
  type AgentProviderContext,
  type AgentProviderPort,
  type AgentToolCall,
  type AgentToolHistoryMessage,
} from './agent-message.port.js';
import {
  agentToolDefinitions,
  agentToolRegistry,
  type AgentToolPorts,
} from './agent-tools.js';

const maxToolRounds = 4;
const maxToolResultBytes = 64 * 1024;
const maxTextBytes = 512 * 1024;
const maxStreamEvents = 8_192;

export class AgentMessageService implements AgentMessagePort {
  public constructor(
    private readonly tx: AgentMessageTransaction,
    private readonly store: AgentMessageStore,
    private readonly provider: AgentProviderPort,
    private readonly tools?: AgentToolPorts,
  ) {}
  public prepare(
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
    command: AgentMessageCommand,
  ): Promise<AgentMessageOutcome> {
    return this.tx.run(subject, async (client) => {
      if (
        !(await this.store.conversationExists(
          client,
          workspaceId,
          conversationId,
        ))
      )
        return { kind: AGENT_MESSAGE_OUTCOMES.NOT_FOUND };
      const fingerprint = computeRequestFingerprint(command);
      const existing = await this.store.readIdempotency(
        client,
        subject,
        workspaceId,
        conversationId,
        key,
      );
      if (existing) {
        if (
          existing.fingerprint !== fingerprint ||
          existing.events.length === 0
        )
          return { kind: AGENT_MESSAGE_OUTCOMES.CONFLICT };
        return {
          kind: AGENT_MESSAGE_OUTCOMES.READY,
          runId: existing.runId,
          replay: existing.events,
        };
      }
      if (
        !(await this.store.consumeRateLimit(
          client,
          subject,
          workspaceId,
          conversationId,
          new Date().toISOString(),
        ))
      )
        return { kind: AGENT_MESSAGE_OUTCOMES.RATE_LIMITED, retryAfter: 60 };
      const runId = randomUUID();
      if (
        !(await this.store.reserveIdempotency(
          client,
          subject,
          workspaceId,
          conversationId,
          key,
          fingerprint,
          runId,
        ))
      )
        return { kind: AGENT_MESSAGE_OUTCOMES.CONFLICT };
      return { kind: AGENT_MESSAGE_OUTCOMES.READY, runId };
    });
  }
  public async execute(
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
    runId: string,
    command: AgentMessageCommand,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
    replay?: readonly AgentEvent[],
  ): Promise<void> {
    if (replay) {
      for (const event of replay) emit(event);
      return;
    }
    const events: AgentEvent[] = [];
    let terminal = false;
    const push = (type: AgentEvent['type'], data: Record<string, unknown>) => {
      if (signal.aborted || terminal) return false;
      const event = { type, runId, timestamp: new Date().toISOString(), data };
      events.push(event);
      emit(event);
      if (
        type === AGENT_EVENT_TYPES.RUN_COMPLETED ||
        type === AGENT_EVENT_TYPES.RUN_FAILED
      )
        terminal = true;
      return true;
    };
    push(AGENT_EVENT_TYPES.RUN_STARTED, {});
    let awaitingApproval = false;
    try {
      awaitingApproval = await this.runTools(
        command,
        { subject, workspaceId },
        signal,
        push,
        () => terminal,
      );
    } catch (error) {
      const failure = error instanceof AgentProviderFailure ? error : null;
      push(AGENT_EVENT_TYPES.RUN_FAILED, {
        message: failure?.message ?? 'Provider failed',
      });
    }
    if (!signal.aborted) {
      push(
        AGENT_EVENT_TYPES.RUN_COMPLETED,
        awaitingApproval ? { awaitingApproval: true } : {},
      );
      await this.tx.run(subject, async (client) => {
        await this.store.saveRun(
          client,
          workspaceId,
          conversationId,
          subject,
          runId,
          command.message,
          events,
        );
        await this.store.finalizeIdempotency(
          client,
          subject,
          workspaceId,
          conversationId,
          key,
          events,
        );
      });
    } else {
      await this.tx.run(subject, (client) =>
        this.store.releaseIdempotency(
          client,
          subject,
          workspaceId,
          conversationId,
          key,
        ),
      );
    }
  }

  private async runTools(
    command: AgentMessageCommand,
    context: AgentProviderContext,
    signal: AbortSignal,
    push: (type: AgentEvent['type'], data: Record<string, unknown>) => void,
    isTerminal: () => boolean,
  ): Promise<boolean> {
    const history: AgentToolHistoryMessage[] = [];
    let toolBytes = 0;
    let textBytes = 0;
    let streamed = 0;
    for (let round = 0; ; round++) {
      signal.throwIfAborted();
      let content = '';
      let calls: readonly AgentToolCall[] | undefined;
      const chunks = this.tools
        ? this.provider.stream(command, signal, context, {
            tools: agentToolDefinitions,
            history: [...history],
          })
        : this.provider.stream(command, signal, context);
      for await (const chunk of chunks) {
        if (signal.aborted) return false;
        if (chunk.type === 'tool_calls') {
          calls = chunk.data.calls;
          break;
        }
        if (++streamed > maxStreamEvents)
          throw new AgentProviderFailure('Provider stream event limit reached');
        if (
          chunk.type === 'text_delta' &&
          typeof chunk.data.text === 'string'
        ) {
          textBytes += Buffer.byteLength(chunk.data.text);
          if (textBytes > maxTextBytes)
            throw new AgentProviderFailure('Provider text size limit reached');
          if (this.tools) content += chunk.data.text;
        }
        push(chunk.type, chunk.data);
        if (isTerminal()) return false;
      }
      if (!calls?.length) return false;
      if (!this.tools || round >= maxToolRounds)
        throw new AgentProviderFailure(
          this.tools
            ? 'Tool round limit reached'
            : 'Unexpected provider tool call',
        );
      history.push({ role: 'assistant', content: content || null, calls });
      for (const call of calls) {
        signal.throwIfAborted();
        const tool = agentToolRegistry.get(call.name);
        if (!tool)
          throw new AgentProviderFailure('Unexpected provider tool call');
        const metadata = { toolName: tool.name, callId: call.id };
        push(AGENT_EVENT_TYPES.TOOL_PROPOSED, {
          ...metadata,
          requiresApproval: tool.requiresApproval,
        });
        signal.throwIfAborted();
        const result = await tool.execute(
          this.tools,
          context,
          call.arguments,
          signal,
        );
        signal.throwIfAborted();
        if (result.kind === 'approval') {
          push(AGENT_EVENT_TYPES.APPROVAL_REQUIRED, {
            ...metadata,
            approvalId: result.approvalId,
          });
          return true;
        }
        const output = JSON.stringify(result.value);
        toolBytes += Buffer.byteLength(output);
        if (toolBytes > maxToolResultBytes)
          throw new AgentProviderFailure('Tool result size limit reached');
        history.push({ role: 'tool', callId: call.id, content: output });
        push(AGENT_EVENT_TYPES.TOOL_COMPLETED, {
          ...metadata,
          ok: result.kind === 'result',
        });
      }
    }
  }
}
