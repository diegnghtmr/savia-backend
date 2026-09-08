import type { TransactionClient } from '../platform/pg-transaction.js';

export const AGENT_MESSAGE_PORT = Symbol('AgentMessagePort');
export const AGENT_PROVIDER_PORT = Symbol('AgentProviderPort');

export const AGENT_MESSAGE_OUTCOMES = {
  READY: 'ready',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
} as const;
export type AgentMessageOutcomeKind =
  (typeof AGENT_MESSAGE_OUTCOMES)[keyof typeof AGENT_MESSAGE_OUTCOMES];

export const AGENT_EVENT_TYPES = {
  RUN_STARTED: 'run_started',
  TEXT_DELTA: 'text_delta',
  TOOL_PROPOSED: 'tool_proposed',
  APPROVAL_REQUIRED: 'approval_required',
  TOOL_COMPLETED: 'tool_completed',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',
} as const;
export type AgentEventType =
  (typeof AGENT_EVENT_TYPES)[keyof typeof AGENT_EVENT_TYPES];

export interface AgentMessageCommand {
  readonly message: string;
  readonly modelRef: string | null;
  readonly credentialId: string | null;
}
export interface AgentEvent {
  readonly type: AgentEventType;
  readonly runId: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}
export interface AgentProviderChunk {
  readonly type: 'text_delta' | 'tool_proposed' | 'tool_completed';
  readonly data: Record<string, unknown>;
}
export interface AgentProviderPort {
  stream(
    command: AgentMessageCommand,
    signal: AbortSignal,
  ): AsyncIterable<AgentProviderChunk>;
}
export interface AgentMessageStore {
  conversationExists(
    client: TransactionClient,
    workspaceId: string,
    conversationId: string,
  ): Promise<boolean>;
  consumeRateLimit(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    now: string,
  ): Promise<boolean>;
  saveRun(
    client: TransactionClient,
    workspaceId: string,
    conversationId: string,
    subject: string,
    runId: string,
    message: string,
    events: readonly AgentEvent[],
  ): Promise<void>;
  readRun(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
  ): Promise<readonly AgentEvent[] | undefined>;
  saveIdempotency(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
    fingerprint: string,
    events: readonly AgentEvent[],
  ): Promise<boolean>;
  readIdempotency(
    client: TransactionClient,
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
  ): Promise<
    { fingerprint: string; events: readonly AgentEvent[] } | undefined
  >;
  createId(): string;
}
export interface AgentMessageTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export interface AgentMessagePort {
  prepare(
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
    command: AgentMessageCommand,
  ): Promise<AgentMessageOutcome>;
  execute(
    subject: string,
    workspaceId: string,
    conversationId: string,
    key: string,
    command: AgentMessageCommand,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
    replay?: readonly AgentEvent[],
  ): Promise<void>;
}
export type AgentMessageOutcome =
  | {
      readonly kind: typeof AGENT_MESSAGE_OUTCOMES.READY;
      readonly runId: string;
      readonly replay?: readonly AgentEvent[];
    }
  | { readonly kind: typeof AGENT_MESSAGE_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof AGENT_MESSAGE_OUTCOMES.NOT_FOUND }
  | { readonly kind: typeof AGENT_MESSAGE_OUTCOMES.CONFLICT }
  | {
      readonly kind: typeof AGENT_MESSAGE_OUTCOMES.RATE_LIMITED;
      readonly retryAfter: number;
    };
