import type { IdempotencyStore } from './idempotency.port.js';
import type { TransactionClient } from './pg-transaction.js';
import type { CreateWorkspaceInvitationCommand } from './workspace-invitation-command.js';
import {
  type WorkspaceInvitation,
  type WorkspaceInvitationCreateOutcome,
  type WorkspaceInvitationListOutcome,
  type WorkspaceInvitationListQuery,
  type WorkspaceInvitationPort,
} from './workspace-invitation.port.js';
import type {
  WorkspaceCursor,
  WorkspaceKind,
  WorkspaceRole,
} from './workspace.port.js';
import type { WorkspaceMembershipRecord } from './workspace.service.js';

export interface WorkspaceInvitationTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export type WorkspaceInvitationReadTransaction = WorkspaceInvitationTransaction;

export interface WorkspaceInvitationStore {
  readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  listInvitations(
    client: TransactionClient,
    workspaceId: string,
    cursor: WorkspaceCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceInvitation[]>;
  readWorkspaceKind(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceKind | undefined>;
  hasActiveMember(
    client: TransactionClient,
    workspaceId: string,
    email: string,
  ): Promise<boolean>;
  findPendingInvitation(
    client: TransactionClient,
    workspaceId: string,
    email: string,
  ): Promise<{ id: string; isExpired: boolean } | undefined>;
  revokeInvitation(
    client: TransactionClient,
    invitationId: string,
  ): Promise<void>;
  createInvitation(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    email: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceInvitation | undefined>;
}

export class WorkspaceInvitationService implements WorkspaceInvitationPort {
  public constructor(
    private readonly transaction: WorkspaceInvitationTransaction,
    private readonly store: WorkspaceInvitationStore,
    private readonly idempotencyStore: IdempotencyStore,
  ) {}

  public listWorkspaceInvitations(
    _subject: string,
    _workspaceId: string,
    _query: WorkspaceInvitationListQuery,
  ): Promise<WorkspaceInvitationListOutcome> {
    throw new Error('Not implemented');
  }

  public createWorkspaceInvitation(
    _subject: string,
    _workspaceId: string,
    _command: CreateWorkspaceInvitationCommand,
    _idempotencyKey: string,
  ): Promise<WorkspaceInvitationCreateOutcome> {
    throw new Error('Not implemented');
  }
}
