import type { WorkspaceMemberUpdateCommand } from './workspace-member-command.js';
import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { WorkspaceMemberStatus, WorkspaceRole } from './workspace.port.js';

export const WORKSPACE_MEMBER_PORT = Symbol('WorkspaceMemberPort');

export interface WorkspaceMember {
  readonly id: string; // workspace_memberships.id  (RULING 14)
  readonly userId: string; // workspace_memberships.profile_id
  readonly displayName: string; // REQUIRED by the authority; never null
  readonly email?: string; // owner/administrator callers only (RULING 11)
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
  readonly joinedAt: string;
}

export type { PageInfo };
export type WorkspaceMemberCursor = Cursor;

export interface WorkspaceMemberListQuery {
  readonly cursor?: WorkspaceMemberCursor;
  readonly limit: number;
}

export interface WorkspaceMemberPage {
  readonly items: readonly WorkspaceMember[];
  readonly pageInfo: PageInfo;
}

export const WORKSPACE_MEMBER_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
} as const;
export type WorkspaceMemberListOutcomeKind =
  (typeof WORKSPACE_MEMBER_LIST_OUTCOMES)[keyof typeof WORKSPACE_MEMBER_LIST_OUTCOMES];

export interface WorkspaceMemberListOk {
  readonly kind: typeof WORKSPACE_MEMBER_LIST_OUTCOMES.OK;
  readonly page: WorkspaceMemberPage;
}
export interface WorkspaceMemberListForbidden {
  readonly kind: typeof WORKSPACE_MEMBER_LIST_OUTCOMES.FORBIDDEN;
}
export interface WorkspaceMemberListNotFound {
  readonly kind: typeof WORKSPACE_MEMBER_LIST_OUTCOMES.NOT_FOUND;
}
export type WorkspaceMemberListOutcome =
  | WorkspaceMemberListOk
  | WorkspaceMemberListForbidden
  | WorkspaceMemberListNotFound;

export const WORKSPACE_MEMBER_UPDATE_OUTCOMES = {
  OK: 'ok',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  PERSONAL_WORKSPACE: 'personal-workspace',
  LAST_OWNER_REQUIRED: 'last-owner-required',
  VERSION_CONFLICT: 'version-conflict',
  CONFLICT: 'conflict',
} as const;
export type WorkspaceMemberUpdateOutcomeKind =
  (typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES)[keyof typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES];

export interface WorkspaceMemberUpdateOk {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK;
  readonly member: WorkspaceMember;
  readonly version: number;
}
export interface WorkspaceMemberUpdateNotFound {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND;
}
export interface WorkspaceMemberUpdateForbidden {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN;
}
export interface WorkspaceMemberUpdatePersonalWorkspace {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.PERSONAL_WORKSPACE;
}
export interface WorkspaceMemberUpdateLastOwnerRequired {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED;
}
export interface WorkspaceMemberUpdateVersionConflict {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT;
}
export interface WorkspaceMemberUpdateConflict {
  readonly kind: typeof WORKSPACE_MEMBER_UPDATE_OUTCOMES.CONFLICT;
}
export type WorkspaceMemberUpdateOutcome =
  | WorkspaceMemberUpdateOk
  | WorkspaceMemberUpdateNotFound
  | WorkspaceMemberUpdateForbidden
  | WorkspaceMemberUpdatePersonalWorkspace
  | WorkspaceMemberUpdateLastOwnerRequired
  | WorkspaceMemberUpdateVersionConflict
  | WorkspaceMemberUpdateConflict;

export const WORKSPACE_MEMBER_REMOVE_OUTCOMES = {
  REMOVED: 'removed',
  REPLAYED: 'replayed',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  PERSONAL_WORKSPACE: 'personal-workspace',
  LAST_OWNER_REQUIRED: 'last-owner-required',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
} as const;
export type WorkspaceMemberRemoveOutcomeKind =
  (typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES)[keyof typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES];

export interface WorkspaceMemberRemoveRemoved {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED;
}
export interface WorkspaceMemberRemoveReplayed {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly problemType?: string;
}
export interface WorkspaceMemberRemoveNotFound {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.NOT_FOUND;
}
export interface WorkspaceMemberRemoveForbidden {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN;
}
export interface WorkspaceMemberRemovePersonalWorkspace {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.PERSONAL_WORKSPACE;
}
export interface WorkspaceMemberRemoveLastOwnerRequired {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED;
}
export interface WorkspaceMemberRemoveIdempotencyConflict {
  readonly kind: typeof WORKSPACE_MEMBER_REMOVE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}
export type WorkspaceMemberRemoveOutcome =
  | WorkspaceMemberRemoveRemoved
  | WorkspaceMemberRemoveReplayed
  | WorkspaceMemberRemoveNotFound
  | WorkspaceMemberRemoveForbidden
  | WorkspaceMemberRemovePersonalWorkspace
  | WorkspaceMemberRemoveLastOwnerRequired
  | WorkspaceMemberRemoveIdempotencyConflict;

export interface WorkspaceMemberPort {
  listWorkspaceMembers(
    subject: string,
    workspaceId: string,
    query: WorkspaceMemberListQuery,
  ): Promise<WorkspaceMemberListOutcome>;
  updateWorkspaceMember(
    subject: string,
    workspaceId: string,
    memberId: string,
    command: WorkspaceMemberUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<WorkspaceMemberUpdateOutcome>;
  removeWorkspaceMember(
    subject: string,
    workspaceId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceMemberRemoveOutcome>;
}
