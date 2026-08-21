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

export interface WorkspacePort {
  read(subject: string, workspaceId: string): Promise<WorkspaceAccess>;
}
