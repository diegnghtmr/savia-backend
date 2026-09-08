import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const MCP_GRANTS_PORT = Symbol('McpGrantsPort');
export const MCP_GRANT_STATUSES = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const;
export type McpGrantStatus =
  (typeof MCP_GRANT_STATUSES)[keyof typeof MCP_GRANT_STATUSES];
export const MCP_GRANT_OUTCOMES = {
  CREATED: 'created',
  OK: 'ok',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
} as const;

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}
export interface CreateMcpGrantCommand {
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly accountIds?: readonly string[];
  readonly maxWriteAmount: Money | null;
  readonly expiresAt: Date | null;
}
export interface McpGrant {
  readonly id: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly accountIds?: readonly string[];
  readonly maxWriteAmount: Money | null;
  readonly status: McpGrantStatus;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}
export interface McpGrantPage {
  readonly items: readonly McpGrant[];
  readonly pageInfo: PageInfo;
}
export interface McpGrantListQuery {
  readonly limit: number;
  readonly cursor?: Cursor;
}
export type McpGrantOutcome =
  | {
      readonly kind: typeof MCP_GRANT_OUTCOMES.CREATED;
      readonly grant: McpGrant;
    }
  | { readonly kind: typeof MCP_GRANT_OUTCOMES.OK; readonly page: McpGrantPage }
  | { readonly kind: typeof MCP_GRANT_OUTCOMES.NOT_FOUND }
  | { readonly kind: typeof MCP_GRANT_OUTCOMES.FORBIDDEN }
  | { readonly kind: typeof MCP_GRANT_OUTCOMES.CONFLICT }
  | { readonly kind: typeof MCP_GRANT_OUTCOMES.INVALID };
export interface McpGrantStore {
  createId(): string;
  hasActiveMemberships(
    client: TransactionClient,
    subject: string,
    workspaceIds: readonly string[],
  ): Promise<boolean>;
  accountsBelongToWorkspaces(
    client: TransactionClient,
    accountIds: readonly string[],
    workspaceIds: readonly string[],
  ): Promise<boolean>;
  create(
    client: TransactionClient,
    subject: string,
    id: string,
    command: CreateMcpGrantCommand,
  ): Promise<McpGrant>;
  list(
    client: TransactionClient,
    subject: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly McpGrant[]>;
  find(
    client: TransactionClient,
    subject: string,
    id: string,
  ): Promise<McpGrant | undefined>;
  revoke(
    client: TransactionClient,
    subject: string,
    id: string,
    now: Date,
  ): Promise<boolean>;
}
export interface McpGrantPort {
  createMcpGrant(
    subject: string,
    command: CreateMcpGrantCommand,
    key: string,
  ): Promise<McpGrantOutcome>;
  listMcpGrants(
    subject: string,
    query: McpGrantListQuery,
  ): Promise<McpGrantOutcome>;
  revokeMcpGrant(
    subject: string,
    id: string,
    key: string,
  ): Promise<McpGrantOutcome>;
}
