import type { TransactionClient } from './pg-transaction.js';
import {
  encodeCursor,
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_MEMBER_STATUS,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceCursor,
  type WorkspaceKind,
  type WorkspaceListQuery,
  type WorkspaceMemberStatus,
  type WorkspacePage,
  type WorkspacePort,
  type WorkspaceRole,
} from './workspace.port.js';

export interface WorkspaceReadTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface WorkspaceMembershipRecord {
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly baseCurrency: string;
  readonly createdAt: string;
  readonly version: number;
}

export interface WorkspaceStore {
  readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  readWorkspace(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceRecord | undefined>;
  listWorkspaces(
    client: TransactionClient,
    subject: string,
    cursor: WorkspaceCursor | undefined,
    limit: number,
  ): Promise<readonly Workspace[]>;
}

export class WorkspaceService implements WorkspacePort {
  public constructor(
    private readonly transaction: WorkspaceReadTransaction,
    private readonly store: WorkspaceStore,
  ) {}

  public read(subject: string, workspaceId: string): Promise<WorkspaceAccess> {
    return this.transaction.runRead(subject, async (client) => {
      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        return { kind: WORKSPACE_ACCESS_KINDS.NOT_FOUND };
      }
      if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_ACCESS_KINDS.FORBIDDEN };
      }
      const workspace = await this.store.readWorkspace(client, workspaceId);
      // Not dead code, and not reachable by any test: the transaction is READ
      // COMMITTED, so this statement takes a newer snapshot than the membership
      // read above. A membership suspended or removed in between makes the
      // hardened policy withhold the row here even though it was active a
      // moment ago. Answering not-found is the right outcome for access revoked
      // mid-request, and it is what keeps the race from dereferencing undefined
      // and becoming a 500.
      if (workspace === undefined) {
        return { kind: WORKSPACE_ACCESS_KINDS.NOT_FOUND };
      }
      return {
        kind: WORKSPACE_ACCESS_KINDS.OK,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          kind: workspace.kind,
          baseCurrency: workspace.baseCurrency,
          role: membership.role,
          createdAt: workspace.createdAt,
          version: workspace.version,
        },
      };
    });
  }

  public list(
    subject: string,
    query: WorkspaceListQuery,
  ): Promise<WorkspacePage> {
    return this.transaction.runRead(subject, async (client) => {
      const rows = await this.store.listWorkspaces(
        client,
        subject,
        query.cursor,
        query.limit + 1,
      );
      const hasNextPage = rows.length > query.limit;
      const items = hasNextPage ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id })
          : null;
      return {
        items,
        pageInfo: {
          hasNextPage,
          nextCursor,
        },
      };
    });
  }
}
