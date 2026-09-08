import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const AGENT_CONVERSATIONS_PORT = Symbol('AGENT_CONVERSATIONS_PORT');
export const AGENT_CONVERSATION_OUTCOMES = {
  CREATED: 'created',
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
} as const;
export type AgentConversationOutcomeKind =
  (typeof AGENT_CONVERSATION_OUTCOMES)[keyof typeof AGENT_CONVERSATION_OUTCOMES];

export interface CreateAgentConversationCommand {
  readonly title: string;
  readonly modelRef: string | null;
  readonly credentialId: string | null;
}
export interface AgentConversation {
  readonly id: string;
  readonly title: string;
  readonly modelRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface AgentConversationStore {
  createId(): string;
  hasActiveMembership(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<boolean>;
  credentialUsable(
    client: TransactionClient,
    workspaceId: string,
    credentialId: string,
  ): Promise<boolean>;
  create(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: CreateAgentConversationCommand,
  ): Promise<AgentConversation>;
  list(
    client: TransactionClient,
    workspaceId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly AgentConversation[]>;
}
export interface AgentConversationPage {
  readonly items: readonly AgentConversation[];
  readonly pageInfo: PageInfo;
}
export type AgentConversationOutcome =
  | {
      readonly kind: typeof AGENT_CONVERSATION_OUTCOMES.CREATED;
      readonly conversation: AgentConversation;
    }
  | {
      readonly kind: typeof AGENT_CONVERSATION_OUTCOMES.OK;
      readonly page: AgentConversationPage;
    }
  | { readonly kind: typeof AGENT_CONVERSATION_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof AGENT_CONVERSATION_OUTCOMES.CONFLICT }
  | { readonly kind: typeof AGENT_CONVERSATION_OUTCOMES.INVALID };
export interface AgentConversationPort {
  createAgentConversation(
    subject: string,
    workspaceId: string,
    command: CreateAgentConversationCommand,
    key: string,
  ): Promise<AgentConversationOutcome>;
  listAgentConversations(
    subject: string,
    workspaceId: string,
    query: { readonly limit: number; readonly cursor?: Cursor },
  ): Promise<AgentConversationOutcome>;
}
