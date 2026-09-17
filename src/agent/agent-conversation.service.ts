import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  AGENT_CONVERSATION_OUTCOMES,
  type AgentConversation,
  type AgentConversationOutcome,
  type AgentConversationPort,
  type AgentConversationStore,
  type CreateAgentConversationCommand,
} from './agent-conversation.port.js';
export interface AgentConversationTransaction {
  run<T>(
    subject: string,
    callback: (c: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (c: TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export class AgentConversationRollbackError extends Error {
  public constructor() {
    super('Agent conversation transaction rollback');
  }
}
export class AgentConversationService implements AgentConversationPort {
  public constructor(
    private readonly tx: AgentConversationTransaction,
    private readonly store: AgentConversationStore,
    private readonly idempotency: IdempotencyStore,
  ) {}
  public async createAgentConversation(
    subject: string,
    workspaceId: string,
    command: CreateAgentConversationCommand,
    key: string,
  ): Promise<AgentConversationOutcome> {
    const route = 'POST /v1/agent/conversations';
    const fingerprint = computeRequestFingerprint(command);
    try {
      return await this.tx.run(subject, async (c) => {
        if (!(await this.store.hasActiveMembership(c, workspaceId)))
          return { kind: AGENT_CONVERSATION_OUTCOMES.FORBIDDEN };
        if (
          command.credentialId &&
          !(await this.store.credentialUsable(
            c,
            workspaceId,
            command.credentialId,
          ))
        )
          return { kind: AGENT_CONVERSATION_OUTCOMES.INVALID };
        const existing = await this.idempotency.read(
          c,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing)
          return existing.requestFingerprint === fingerprint
            ? {
                kind: AGENT_CONVERSATION_OUTCOMES.CREATED,
                conversation: existing.responseBody as AgentConversation,
              }
            : { kind: AGENT_CONVERSATION_OUTCOMES.CONFLICT };
        const conversation = await this.store.create(
          c,
          workspaceId,
          subject,
          this.store.createId(),
          command,
        );
        if (
          !(await this.idempotency.write(
            c,
            subject,
            route,
            key,
            fingerprint,
            201,
            null,
            conversation,
            workspaceId,
          ))
        )
          throw new AgentConversationRollbackError();
        return { kind: AGENT_CONVERSATION_OUTCOMES.CREATED, conversation };
      });
    } catch (e) {
      if (e instanceof AgentConversationRollbackError)
        return { kind: AGENT_CONVERSATION_OUTCOMES.CONFLICT };
      throw e;
    }
  }
  public listAgentConversations(
    subject: string,
    workspaceId: string,
    query: {
      readonly limit: number;
      readonly cursor?: import('../platform/cursor.js').Cursor;
    },
  ): Promise<AgentConversationOutcome> {
    return this.tx.runRead(subject, async (c) => {
      if (!(await this.store.hasActiveMembership(c, workspaceId)))
        return { kind: AGENT_CONVERSATION_OUTCOMES.FORBIDDEN };
      const rows = await this.store.list(
        c,
        workspaceId,
        query.limit + 1,
        query.cursor,
      );
      const hasNextPage = rows.length > query.limit;
      const items = hasNextPage ? rows.slice(0, query.limit) : rows;
      const last = items[items.length - 1];
      return {
        kind: AGENT_CONVERSATION_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    createdAt: last.createdAt,
                    id: last.id,
                    workspaceId,
                  })
                : null,
          },
        },
      };
    });
  }
}
