import type { TransactionClient } from './pg-transaction.js';
import type {
  WorkspaceInvitation,
} from './workspace-invitation.port.js';
import type { WorkspaceInvitationStore } from './workspace-invitation.service.js';
import type {
  WorkspaceCursor,
  WorkspaceKind,
  WorkspaceRole,
} from './workspace.port.js';
import type { WorkspaceMembershipRecord } from './workspace.service.js';

export class PostgresWorkspaceInvitationAdapter
  implements WorkspaceInvitationStore
{
  public async readMembership(
    _client: TransactionClient,
    _workspaceId: string,
    _subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined> {
    throw new Error('Not implemented');
  }

  public async listInvitations(
    _client: TransactionClient,
    _workspaceId: string,
    _cursor: WorkspaceCursor | undefined,
    _limit: number,
  ): Promise<readonly WorkspaceInvitation[]> {
    throw new Error('Not implemented');
  }

  public async readWorkspaceKind(
    _client: TransactionClient,
    _workspaceId: string,
  ): Promise<WorkspaceKind | undefined> {
    throw new Error('Not implemented');
  }

  public async hasActiveMember(
    _client: TransactionClient,
    _workspaceId: string,
    _email: string,
  ): Promise<boolean> {
    throw new Error('Not implemented');
  }

  public async findPendingInvitation(
    _client: TransactionClient,
    _workspaceId: string,
    _email: string,
  ): Promise<{ id: string; isExpired: boolean } | undefined> {
    throw new Error('Not implemented');
  }

  public async revokeInvitation(
    _client: TransactionClient,
    _invitationId: string,
  ): Promise<void> {
    throw new Error('Not implemented');
  }

  public async createInvitation(
    _client: TransactionClient,
    _workspaceId: string,
    _subject: string,
    _email: string,
    _role: WorkspaceRole,
  ): Promise<WorkspaceInvitation | undefined> {
    throw new Error('Not implemented');
  }
}
