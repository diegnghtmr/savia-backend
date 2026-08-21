import type { TransactionClient } from './pg-transaction.js';
import {
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_MEMBER_STATUS,
  type WorkspaceAccess,
  type WorkspaceKind,
  type WorkspaceMemberStatus,
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
}
