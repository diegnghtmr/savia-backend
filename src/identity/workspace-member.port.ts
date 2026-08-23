import type {
  PageInfo,
  WorkspaceMemberStatus,
  WorkspaceRole,
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
  readonly workspaceId: string;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Maximum encoded cursor length arithmetic:
// - Workspace UUID: 36 characters
// - JoinedAt ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SS.sssZ): 24 characters
// - Membership UUID: 36 characters
// - JSON array punctuation and quotes `["<uuid>","<iso>","<uuid>"]`:
//   1 ([) + 1 (") + 36 + 1 (") + 1 (,) + 1 (") + 24 + 1 (") + 1 (,) + 1 (") + 36 + 1 (") + 1 (]) = 106 UTF-8 bytes.
// - Unpadded base64url encoding expands 106 bytes to Math.ceil(106 * 4 / 3) = 142 characters (144 chars if padded).
// - Bound to 256 characters (rounding up with headroom) to strictly bound length and prevent unbounded memory or compute allocation.
export const MAX_MEMBER_CURSOR_LENGTH = 256;

export function encodeMemberCursor(cursor: WorkspaceMemberCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.workspaceId, cursor.joinedAt, cursor.membershipId]),
  ).toString('base64url');
}

export function decodeMemberCursor(
  raw: string,
  expectedWorkspaceId?: string,
): WorkspaceMemberCursor | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_MEMBER_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(raw)
  ) {
    return undefined;
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [workspaceId, joinedAt, membershipId] = parsed;
    if (
      typeof workspaceId !== 'string' ||
      typeof joinedAt !== 'string' ||
      typeof membershipId !== 'string'
    ) {
      return undefined;
    }
    // Reject non-canonical payloads (e.g. trailing whitespace or non-canonical JSON representation)
    if (json !== JSON.stringify(parsed)) {
      return undefined;
    }
    if (!UUID_PATTERN.test(workspaceId)) return undefined;
    // Date.parse alone is insufficient because it accepts instants outside PostgreSQL's
    // timestamptz text-input range (e.g. extended years, year 0000), which would surface
    // as an unhandled 500 from a client-supplied query parameter.
    if (
      !ISO_TIMESTAMP_PATTERN.test(joinedAt) ||
      new Date(joinedAt).toISOString() !== joinedAt
    ) {
      return undefined;
    }
    if (!UUID_PATTERN.test(membershipId)) return undefined;
    if (
      expectedWorkspaceId !== undefined &&
      workspaceId !== expectedWorkspaceId
    ) {
      return undefined;
    }
    return { workspaceId, joinedAt, membershipId };
  } catch {
    return undefined;
  }
}

export interface WorkspaceMemberPort {
  listWorkspaceMembers(
    subject: string,
    workspaceId: string,
    query: WorkspaceMemberListQuery,
  ): Promise<WorkspaceMemberListOutcome>;
}
