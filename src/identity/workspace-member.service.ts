import type { TransactionClient } from './pg-transaction.js';
import {
  encodeMemberCursor,
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  type WorkspaceMember,
  type WorkspaceMemberCursor,
  type WorkspaceMemberListOutcome,
  type WorkspaceMemberListQuery,
  type WorkspaceMemberPort,
} from './workspace-member.port.js';
import { WORKSPACE_MEMBER_STATUS } from './workspace.port.js';
import type { WorkspaceMembershipRecord } from './workspace.service.js';

export interface WorkspaceMemberReadTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface WorkspaceMemberStore {
  readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  listRoster(
    client: TransactionClient,
    workspaceId: string,
    cursor: WorkspaceMemberCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceMember[]>;
}

export class WorkspaceMemberService implements WorkspaceMemberPort {
  public constructor(
    private readonly transaction: WorkspaceMemberReadTransaction,
    private readonly store: WorkspaceMemberStore,
  ) {}

  // runRead, NOT run. listWorkspaceMembers is a read path: it ends in ROLLBACK, has no
  // commit-uncertainty branch, and therefore declares 500 and never 503 in the contract.
  // The Visibility Rule is decided HERE, not by the projection returning zero rows, because
  // the spec distinguishes 403 from 404: readMembership reads the caller's own row, always
  // visible under the unchanged application_reads_own_membership (202607150002:38-44).
  public listWorkspaceMembers(
    subject: string,
    workspaceId: string,
    query: WorkspaceMemberListQuery,
  ): Promise<WorkspaceMemberListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      const membership = await this.store.readMembership(
        client,
        workspaceId,
        subject,
      );
      if (membership === undefined) {
        return { kind: WORKSPACE_MEMBER_LIST_OUTCOMES.NOT_FOUND };
      }
      if (membership.status === WORKSPACE_MEMBER_STATUS.SUSPENDED) {
        return { kind: WORKSPACE_MEMBER_LIST_OUTCOMES.FORBIDDEN };
      }

      const rows = await this.store.listRoster(
        client,
        workspaceId,
        query.cursor,
        query.limit + 1,
      );
      const hasNextPage = rows.length > query.limit;
      const items = hasNextPage ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeMemberCursor({
              workspaceId,
              joinedAt: lastItem.joinedAt,
              membershipId: lastItem.id,
            })
          : null;
      return {
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
        page: { items, pageInfo: { hasNextPage, nextCursor } },
      };
    });
  }
}
