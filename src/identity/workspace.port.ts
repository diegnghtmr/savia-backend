import type {
  WorkspaceCreateCommand,
  WorkspaceUpdateCommand,
} from './workspace-command.js';

export const WORKSPACE_PORT = Symbol('WorkspacePort');

export const WORKSPACE_KIND = {
  PERSONAL: 'personal',
  FAMILY: 'family',
  SHARED: 'shared',
} as const;
export type WorkspaceKind =
  (typeof WORKSPACE_KIND)[keyof typeof WORKSPACE_KIND];

export const WORKSPACE_ROLE = {
  OWNER: 'owner',
  ADMINISTRATOR: 'administrator',
  EDITOR: 'editor',
  VIEWER: 'viewer',
} as const;
export type WorkspaceRole =
  (typeof WORKSPACE_ROLE)[keyof typeof WORKSPACE_ROLE];

export const WORKSPACE_MEMBER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;
export type WorkspaceMemberStatus =
  (typeof WORKSPACE_MEMBER_STATUS)[keyof typeof WORKSPACE_MEMBER_STATUS];

export const WORKSPACE_ACCESS_KINDS = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found',
} as const;
export type WorkspaceAccessKind =
  (typeof WORKSPACE_ACCESS_KINDS)[keyof typeof WORKSPACE_ACCESS_KINDS];

export const WORKSPACE_UPDATE_OUTCOMES = {
  OK: 'ok',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  VERSION_CONFLICT: 'version-conflict',
} as const;
export type WorkspaceUpdateOutcomeKind =
  (typeof WORKSPACE_UPDATE_OUTCOMES)[keyof typeof WORKSPACE_UPDATE_OUTCOMES];

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly baseCurrency: string;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
  readonly version: number;
}

export interface WorkspaceAccessOk {
  readonly kind: typeof WORKSPACE_ACCESS_KINDS.OK;
  readonly workspace: Workspace;
}

export interface WorkspaceAccessForbidden {
  readonly kind: typeof WORKSPACE_ACCESS_KINDS.FORBIDDEN;
}

export interface WorkspaceAccessNotFound {
  readonly kind: typeof WORKSPACE_ACCESS_KINDS.NOT_FOUND;
}

export type WorkspaceAccess =
  | WorkspaceAccessOk
  | WorkspaceAccessForbidden
  | WorkspaceAccessNotFound;

export const WORKSPACE_CREATE_OUTCOME_KINDS = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
} as const;
export type WorkspaceCreateOutcomeKind =
  (typeof WORKSPACE_CREATE_OUTCOME_KINDS)[keyof typeof WORKSPACE_CREATE_OUTCOME_KINDS];

export interface WorkspaceCreateCreatedOutcome {
  readonly kind: typeof WORKSPACE_CREATE_OUTCOME_KINDS.CREATED;
  readonly workspace: Workspace;
}

export interface WorkspaceCreateReplayedOutcome {
  readonly kind: typeof WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface WorkspaceCreateConflictOutcome {
  readonly kind: typeof WORKSPACE_CREATE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT;
}

export type WorkspaceCreateOutcome =
  | WorkspaceCreateCreatedOutcome
  | WorkspaceCreateReplayedOutcome
  | WorkspaceCreateConflictOutcome;

export interface WorkspaceUpdateOk {
  readonly kind: typeof WORKSPACE_UPDATE_OUTCOMES.OK;
  readonly workspace: Workspace;
  readonly version: number;
}

export interface WorkspaceUpdateNotFound {
  readonly kind: typeof WORKSPACE_UPDATE_OUTCOMES.NOT_FOUND;
}

export interface WorkspaceUpdateForbidden {
  readonly kind: typeof WORKSPACE_UPDATE_OUTCOMES.FORBIDDEN;
}

export interface WorkspaceUpdateVersionConflict {
  readonly kind: typeof WORKSPACE_UPDATE_OUTCOMES.VERSION_CONFLICT;
}

export type WorkspaceUpdateOutcome =
  | WorkspaceUpdateOk
  | WorkspaceUpdateNotFound
  | WorkspaceUpdateForbidden
  | WorkspaceUpdateVersionConflict;

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly nextCursor: string | null;
}

export interface WorkspacePage {
  readonly items: readonly Workspace[];
  readonly pageInfo: PageInfo;
}

export interface WorkspaceCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface WorkspaceListQuery {
  readonly cursor?: WorkspaceCursor;
  readonly limit: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeCursor(cursor: WorkspaceCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString(
    'base64url',
  );
}

export function decodeCursor(raw: string): WorkspaceCursor | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    !BASE64URL_PATTERN.test(raw)
  ) {
    return undefined;
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || typeof id !== 'string') {
      return undefined;
    }
    // Date.parse alone is insufficient because it accepts instants outside PostgreSQL's
    // timestamptz text-input range (e.g. extended years, year 0000), which would surface
    // as an unhandled 500 from a client-supplied query parameter.
    if (
      !ISO_TIMESTAMP_PATTERN.test(createdAt) ||
      new Date(createdAt).toISOString() !== createdAt
    ) {
      return undefined;
    }
    if (!UUID_PATTERN.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

export const WORKSPACE_DELETE_OUTCOME_KINDS = {
  DELETED: 'deleted',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  UNPROCESSABLE: 'unprocessable',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency-conflict',
} as const;
export type WorkspaceDeleteOutcomeKind =
  (typeof WORKSPACE_DELETE_OUTCOME_KINDS)[keyof typeof WORKSPACE_DELETE_OUTCOME_KINDS];

export interface WorkspaceDeleteDeletedOutcome {
  readonly kind: typeof WORKSPACE_DELETE_OUTCOME_KINDS.DELETED;
}

export interface WorkspaceDeleteNotFoundOutcome {
  readonly kind: typeof WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND;
}

export interface WorkspaceDeleteForbiddenOutcome {
  readonly kind: typeof WORKSPACE_DELETE_OUTCOME_KINDS.FORBIDDEN;
}

export interface WorkspaceDeleteUnprocessableOutcome {
  readonly kind: typeof WORKSPACE_DELETE_OUTCOME_KINDS.UNPROCESSABLE;
}

export interface WorkspaceDeleteReplayedOutcome {
  readonly kind: typeof WORKSPACE_DELETE_OUTCOME_KINDS.REPLAYED;
  readonly status: number;
}

export interface WorkspaceDeleteConflictOutcome {
  readonly kind: typeof WORKSPACE_DELETE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT;
}

export type WorkspaceDeleteOutcome =
  | WorkspaceDeleteDeletedOutcome
  | WorkspaceDeleteNotFoundOutcome
  | WorkspaceDeleteForbiddenOutcome
  | WorkspaceDeleteUnprocessableOutcome
  | WorkspaceDeleteReplayedOutcome
  | WorkspaceDeleteConflictOutcome;

export interface WorkspacePort {
  read(subject: string, workspaceId: string): Promise<WorkspaceAccess>;
  list(subject: string, query: WorkspaceListQuery): Promise<WorkspacePage>;
  create(
    subject: string,
    command: WorkspaceCreateCommand,
    idempotencyKey: string,
  ): Promise<WorkspaceCreateOutcome>;
  update(
    subject: string,
    workspaceId: string,
    command: WorkspaceUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<WorkspaceUpdateOutcome>;
  delete(
    subject: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceDeleteOutcome>;
}
