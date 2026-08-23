import type { TransactionClient } from './pg-transaction.js';
import type {
  WorkspaceMember,
  WorkspaceMemberCursor,
} from './workspace-member.port.js';
import type {
  WorkspaceMembershipDetailRecord,
  WorkspaceMemberStore,
} from './workspace-member.service.js';
import type {
  WorkspaceKind,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from './workspace.port.js';
import type { WorkspaceMembershipRecord } from './workspace.service.js';

export class PostgresWorkspaceMemberAdapter implements WorkspaceMemberStore {
  // The caller's own row, visible under the unchanged application_reads_own_membership
  // (202607150002:38-44). Same statement as PostgresWorkspaceAdapter.readMembership
  // (postgres-workspace.adapter.ts:19-29); deliberately not shared, so slice 2 does not
  // refactor the workspace adapter.
  public async readMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
  ): Promise<WorkspaceMembershipRecord | undefined> {
    const result = await client.query<WorkspaceMembershipRow>(
      'select role, status from public.workspace_memberships where workspace_id = $1 and profile_id = $2',
      [workspaceId, subject],
    );
    return result.rows[0];
  }

  // Reads through the security-definer projection, never through a plain join: a plain join to
  // public.profiles is blind for peers under application_reads_own_profile and would return a
  // NULL displayName, which the authority declares required.
  public async listRoster(
    client: TransactionClient,
    workspaceId: string,
    cursor: WorkspaceMemberCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceMember[]> {
    const result = await client.query<WorkspaceMemberRow>(
      `select roster.membership_id::text as "id",
              roster.profile_id::text as "userId",
              roster.display_name as "displayName",
              roster.email,
              roster.role,
              roster.status,
              roster.joined_at as "joinedAt"
         from public.workspace_member_roster($1) roster
        where $2::timestamptz is null
           or (roster.joined_at, roster.membership_id) > ($2::timestamptz, $3::uuid)
        order by roster.joined_at, roster.membership_id
        limit $4`,
      [
        workspaceId,
        cursor?.joinedAt ?? null,
        cursor?.membershipId ?? null,
        limit,
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      displayName: row.displayName,
      // The authority declares WorkspaceMember.email as `type: string, format: email` and
      // does NOT declare it nullable, with additionalProperties: false. A JSON `null` would
      // therefore be schema-invalid. Withholding email means OMITTING the property.
      ...(row.email === null ? {} : { email: row.email }),
      role: row.role,
      status: row.status,
      joinedAt:
        row.joinedAt instanceof Date
          ? row.joinedAt.toISOString()
          : String(row.joinedAt),
    }));
  }

  public async readWorkspaceKind(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceKind | undefined> {
    const result = await client.query<{ kind: WorkspaceKind }>(
      'select kind from public.workspaces where id = $1',
      [workspaceId],
    );
    return result.rows[0]?.kind;
  }

  public async readMembershipById(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
  ): Promise<WorkspaceMembershipDetailRecord | undefined> {
    const result = await client.query<WorkspaceMembershipDetailRow>(
      `select id::text,
              profile_id::text as "profileId",
              role,
              status,
              version
         from public.workspace_memberships
        where id = $1 and workspace_id = $2`,
      [memberId, workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      profileId: row.profileId,
      role: row.role,
      status: row.status,
      version: row.version,
    };
  }

  public async retainsActiveOwner(
    client: TransactionClient,
    workspaceId: string,
    excludedMembershipId: string,
  ): Promise<boolean> {
    const result = await client.query<{ retained: boolean }>(
      'select public.collaborative_workspace_retains_active_owner($1::uuid, $2::uuid) as retained',
      [workspaceId, excludedMembershipId],
    );
    return Boolean(result.rows[0]?.retained);
  }

  public async updateMemberRole(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
    role: WorkspaceRole,
    expectedVersion?: number | readonly number[],
  ): Promise<{ rowCount: number; version?: number }> {
    const versions =
      typeof expectedVersion === 'number'
        ? [expectedVersion]
        : (expectedVersion ?? null);
    const values = [role, memberId, workspaceId, versions];
    const result = await client.query<{ version: number }>(
      `update public.workspace_memberships
          set role = $1, version = version + 1
        where id = $2 and workspace_id = $3
          and ($4::integer[] is null or version = any($4::integer[]))
    returning version`,
      values,
    );
    const row = result.rows[0];
    return {
      rowCount: result.rowCount ?? 0,
      version: row?.version,
    };
  }

  public async enforceDeferredConstraints(
    client: TransactionClient,
  ): Promise<void> {
    await client.query('set constraints all immediate');
  }

  public async deleteMember(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
  ): Promise<number> {
    const result = await client.query(
      'delete from public.workspace_memberships where id = $1 and workspace_id = $2',
      [memberId, workspaceId],
    );
    return result.rowCount ?? 0;
  }

  public async readRosterMember(
    client: TransactionClient,
    workspaceId: string,
    memberId: string,
  ): Promise<WorkspaceMember | undefined> {
    const result = await client.query<WorkspaceMemberRow>(
      `select roster.membership_id::text as "id",
              roster.profile_id::text as "userId",
              roster.display_name as "displayName",
              roster.email,
              roster.role,
              roster.status,
              roster.joined_at as "joinedAt"
         from public.workspace_member_roster($1) roster
        where roster.membership_id = $2::uuid`,
      [workspaceId, memberId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      userId: row.userId,
      displayName: row.displayName,
      ...(row.email === null ? {} : { email: row.email }),
      role: row.role,
      status: row.status,
      joinedAt:
        row.joinedAt instanceof Date
          ? row.joinedAt.toISOString()
          : String(row.joinedAt),
    };
  }
}

interface WorkspaceMembershipRow
  extends WorkspaceMembershipRecord,
    Record<string, unknown> {}

interface WorkspaceMembershipDetailRow extends Record<string, unknown> {
  readonly id: string;
  readonly profileId: string;
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
  readonly version: number;
}

interface WorkspaceMemberRow extends Record<string, unknown> {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: WorkspaceRole;
  readonly status: WorkspaceMemberStatus;
  readonly joinedAt: Date | string;
}
