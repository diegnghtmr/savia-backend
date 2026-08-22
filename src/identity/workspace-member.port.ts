import {
  decodeCursor,
  encodeCursor,
  type PageInfo,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from './workspace.port.js';

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

export interface WorkspaceMemberCursor {
  readonly joinedAt: string;
  readonly membershipId: string;
}

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

// The roster cursor reuses the hardened codec at workspace.port.ts:156-192 rather than
// re-implementing it. decodeCursor validates the timestamp against the exact set PostgreSQL's
// timestamptz text input accepts -- a strict `YYYY-MM-DDTHH:MM:SS.sssZ` pattern PLUS a
// `new Date(x).toISOString() === x` round-trip -- because Date.parse alone accepts instants
// outside that range (extended years, year 0000) which would surface as an unhandled 500 from a
// client-supplied query parameter. Never replace this with Date.parse.
export function encodeMemberCursor(cursor: WorkspaceMemberCursor): string {
  return encodeCursor({ createdAt: cursor.joinedAt, id: cursor.membershipId });
}

export function decodeMemberCursor(
  raw: string,
): WorkspaceMemberCursor | undefined {
  const decoded = decodeCursor(raw);
  if (decoded === undefined) return undefined;
  return { joinedAt: decoded.createdAt, membershipId: decoded.id };
}

export interface WorkspaceMemberPort {
  listWorkspaceMembers(
    subject: string,
    workspaceId: string,
    query: WorkspaceMemberListQuery,
  ): Promise<WorkspaceMemberListOutcome>;
}
