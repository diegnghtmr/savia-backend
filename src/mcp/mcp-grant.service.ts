import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  MCP_GRANT_OUTCOMES,
  type McpGrantOutcome,
  type McpGrantPort,
  type McpGrantStore,
  type McpGrantListQuery,
  type CreateMcpGrantCommand,
  type McpGrant,
} from './mcp-grant.port.js';
export interface McpGrantTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export class McpGrantRollbackError extends Error {
  public constructor(
    public readonly outcome: typeof MCP_GRANT_OUTCOMES.CONFLICT,
  ) {
    super('MCP grant transaction rollback');
  }
}
export class McpGrantService implements McpGrantPort {
  public constructor(
    private readonly tx: McpGrantTransaction,
    private readonly store: McpGrantStore,
    private readonly idempotency: IdempotencyStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  public async createMcpGrant(
    subject: string,
    command: CreateMcpGrantCommand,
    key: string,
  ): Promise<McpGrantOutcome> {
    const route = 'POST /v1/mcp/grants';
    const fingerprint = computeRequestFingerprint(command);
    try {
      return await this.tx.run(subject, async (client) => {
        if (
          !(await this.store.canMint(
            client,
            subject,
            command.scopes,
            command.workspaceIds,
          ))
        )
          return { kind: MCP_GRANT_OUTCOMES.FORBIDDEN };
        if (
          command.accountIds &&
          !(await this.store.accountsBelongToWorkspaces(
            client,
            command.accountIds,
            command.workspaceIds,
          ))
        )
          return { kind: MCP_GRANT_OUTCOMES.INVALID };
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          null,
        );
        if (existing)
          return existing.requestFingerprint === fingerprint
            ? {
                kind: MCP_GRANT_OUTCOMES.CREATED,
                grant: existing.responseBody as McpGrant,
              }
            : { kind: MCP_GRANT_OUTCOMES.CONFLICT };
        const grant = await this.store.create(
          client,
          subject,
          this.store.createId(),
          command,
        );
        if (
          !(await this.idempotency.write(
            client,
            subject,
            route,
            key,
            fingerprint,
            201,
            null,
            grant,
            null,
          ))
        )
          throw new McpGrantRollbackError(MCP_GRANT_OUTCOMES.CONFLICT);
        return { kind: MCP_GRANT_OUTCOMES.CREATED, grant };
      });
    } catch (error) {
      if (error instanceof McpGrantRollbackError)
        return { kind: error.outcome };
      throw error;
    }
  }
  public listMcpGrants(
    subject: string,
    query: McpGrantListQuery,
  ): Promise<McpGrantOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const rows = await this.store.list(
        client,
        subject,
        query.limit + 1,
        query.cursor,
      );
      const hasNextPage = rows.length > query.limit;
      const items = hasNextPage ? rows.slice(0, query.limit) : rows;
      const last = items[items.length - 1];
      const effectiveItems = items.map((item) =>
        item.status === 'active' &&
        item.expiresAt !== null &&
        new Date(item.expiresAt).getTime() <= this.clock().getTime()
          ? { ...item, status: 'expired' as const }
          : item,
      );
      return {
        kind: MCP_GRANT_OUTCOMES.OK,
        page: {
          items: effectiveItems,
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({ createdAt: last.createdAt, id: last.id })
                : null,
          },
        },
      };
    });
  }
  public async revokeMcpGrant(
    subject: string,
    id: string,
    key: string,
  ): Promise<McpGrantOutcome> {
    const route = 'DELETE /v1/mcp/grants/{grantId}';
    const fingerprint = computeRequestFingerprint({ grantId: id });
    try {
      return await this.tx.run(subject, async (client) => {
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          null,
        );
        if (existing)
          return existing.requestFingerprint === fingerprint
            ? {
                kind: MCP_GRANT_OUTCOMES.OK,
                page: {
                  items: [],
                  pageInfo: { hasNextPage: false, nextCursor: null },
                },
              }
            : { kind: MCP_GRANT_OUTCOMES.CONFLICT };
        const grant = await this.store.find(client, subject, id);
        if (!grant) return { kind: MCP_GRANT_OUTCOMES.NOT_FOUND };
        if (
          grant.status !== 'active' ||
          (grant.expiresAt &&
            new Date(grant.expiresAt).getTime() <= this.clock().getTime())
        )
          return { kind: MCP_GRANT_OUTCOMES.CONFLICT };
        if (!(await this.store.revoke(client, subject, id, this.clock())))
          return { kind: MCP_GRANT_OUTCOMES.CONFLICT };
        if (
          !(await this.idempotency.write(
            client,
            subject,
            route,
            key,
            fingerprint,
            204,
            null,
            null,
            null,
          ))
        )
          throw new McpGrantRollbackError(MCP_GRANT_OUTCOMES.CONFLICT);
        return {
          kind: MCP_GRANT_OUTCOMES.OK,
          page: {
            items: [],
            pageInfo: { hasNextPage: false, nextCursor: null },
          },
        };
      });
    } catch (error) {
      if (error instanceof McpGrantRollbackError)
        return { kind: error.outcome };
      throw error;
    }
  }
}
