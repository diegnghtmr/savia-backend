import type { CreateWorkspaceInvitationCommand } from './workspace-invitation-command.js';
import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { WorkspaceRole } from './workspace.port.js';

export const WORKSPACE_INVITATION_PORT = Symbol('WorkspaceInvitationPort');

export type { PageInfo };

export interface WorkspaceInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface WorkspaceInvitationListQuery {
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface WorkspaceInvitationPage {
  readonly items: readonly WorkspaceInvitation[];
  readonly pageInfo: PageInfo;
}

export const WORKSPACE_INVITATION_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
} as const;
export type WorkspaceInvitationListOutcomeKind =
  (typeof WORKSPACE_INVITATION_LIST_OUTCOMES)[keyof typeof WORKSPACE_INVITATION_LIST_OUTCOMES];

export interface WorkspaceInvitationListOk {
  readonly kind: typeof WORKSPACE_INVITATION_LIST_OUTCOMES.OK;
  readonly page: WorkspaceInvitationPage;
}
export interface WorkspaceInvitationListForbidden {
  readonly kind: typeof WORKSPACE_INVITATION_LIST_OUTCOMES.FORBIDDEN;
}
export interface WorkspaceInvitationListNotFound {
  readonly kind: typeof WORKSPACE_INVITATION_LIST_OUTCOMES.NOT_FOUND;
}
export type WorkspaceInvitationListOutcome =
  | WorkspaceInvitationListOk
  | WorkspaceInvitationListForbidden
  | WorkspaceInvitationListNotFound;

export const WORKSPACE_INVITATION_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  PERSONAL_WORKSPACE: 'personal-workspace',
  EXISTING_MEMBER: 'existing-member',
  ALREADY_PENDING: 'already-pending',
} as const;
export type WorkspaceInvitationCreateOutcomeKind =
  (typeof WORKSPACE_INVITATION_CREATE_OUTCOMES)[keyof typeof WORKSPACE_INVITATION_CREATE_OUTCOMES];

export interface WorkspaceInvitationCreateCreated {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED;
  readonly invitation: WorkspaceInvitation;
}
export interface WorkspaceInvitationCreateReplayed {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly body: unknown;
}
export interface WorkspaceInvitationCreateIdempotencyConflict {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}
export interface WorkspaceInvitationCreateForbidden {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN;
}
export interface WorkspaceInvitationCreateNotFound {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND;
}
export interface WorkspaceInvitationCreatePersonalWorkspace {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.PERSONAL_WORKSPACE;
}
export interface WorkspaceInvitationCreateExistingMember {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.EXISTING_MEMBER;
}
export interface WorkspaceInvitationCreateAlreadyPending {
  readonly kind: typeof WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING;
}
export type WorkspaceInvitationCreateOutcome =
  | WorkspaceInvitationCreateCreated
  | WorkspaceInvitationCreateReplayed
  | WorkspaceInvitationCreateIdempotencyConflict
  | WorkspaceInvitationCreateForbidden
  | WorkspaceInvitationCreateNotFound
  | WorkspaceInvitationCreatePersonalWorkspace
  | WorkspaceInvitationCreateExistingMember
  | WorkspaceInvitationCreateAlreadyPending;

export const WORKSPACE_INVITATION_REVOKE_OUTCOMES = {
  OK: 'ok',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
  NOT_PENDING: 'not-pending',
} as const;
export type WorkspaceInvitationRevokeOutcomeKind =
  (typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES)[keyof typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES];

export interface WorkspaceInvitationRevokeOk {
  readonly kind: typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES.OK;
  readonly invitation: WorkspaceInvitation;
}
export interface WorkspaceInvitationRevokeReplayed {
  readonly kind: typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly body: unknown;
}
export interface WorkspaceInvitationRevokeIdempotencyConflict {
  readonly kind: typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}
export interface WorkspaceInvitationRevokeForbidden {
  readonly kind: typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES.FORBIDDEN;
}
export interface WorkspaceInvitationRevokeNotFound {
  readonly kind: typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES.NOT_FOUND;
}
export interface WorkspaceInvitationRevokeNotPending {
  readonly kind: typeof WORKSPACE_INVITATION_REVOKE_OUTCOMES.NOT_PENDING;
}
export type WorkspaceInvitationRevokeOutcome =
  | WorkspaceInvitationRevokeOk
  | WorkspaceInvitationRevokeReplayed
  | WorkspaceInvitationRevokeIdempotencyConflict
  | WorkspaceInvitationRevokeForbidden
  | WorkspaceInvitationRevokeNotFound
  | WorkspaceInvitationRevokeNotPending;

export interface WorkspaceInvitationPort {
  listWorkspaceInvitations(
    subject: string,
    workspaceId: string,
    query: WorkspaceInvitationListQuery,
  ): Promise<WorkspaceInvitationListOutcome>;
  createWorkspaceInvitation(
    subject: string,
    workspaceId: string,
    command: CreateWorkspaceInvitationCommand,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationCreateOutcome>;
  revokeWorkspaceInvitation(
    subject: string,
    workspaceId: string,
    invitationId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceInvitationRevokeOutcome>;
}
