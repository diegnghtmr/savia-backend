import { randomUUID } from 'node:crypto';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import {
  AGENT_EVENT_TYPES,
  AGENT_MESSAGE_OUTCOMES,
  type AgentEvent,
  type AgentMessageCommand,
  type AgentMessageOutcome,
  type AgentMessagePort,
  type AgentMessageStore,
  type AgentMessageTransaction,
  type AgentProviderPort,
} from './agent-message.port.js';

export class AgentMessageService implements AgentMessagePort {
  public constructor(
    private readonly tx: AgentMessageTransaction,
    private readonly store: AgentMessageStore,
    private readonly provider: AgentProviderPort,
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
    try {
      for await (const chunk of this.provider.stream(command, signal)) {
        if (signal.aborted) break;
        push(chunk.type, chunk.data);
        if (terminal) break;
        if (
          chunk.type === 'tool_proposed' &&
          chunk.data.requiresApproval === true
        )
          push(AGENT_EVENT_TYPES.APPROVAL_REQUIRED, {
            deferred: true,
            reason: 'Approval creation is not exposed by APPROVALS_PORT.',
          });
      }
      if (!signal.aborted) push(AGENT_EVENT_TYPES.RUN_COMPLETED, {});
      if (!signal.aborted)
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
      else
        await this.tx.run(subject, (client) =>
          this.store.releaseIdempotency(
            client,
            subject,
            workspaceId,
            conversationId,
            key,
          ),
        );
    } catch (error) {
      if (!signal.aborted) {
        push(AGENT_EVENT_TYPES.RUN_FAILED, {
          message: error instanceof Error ? error.message : 'Provider failed',
        });
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
      }
    }
  }
}
