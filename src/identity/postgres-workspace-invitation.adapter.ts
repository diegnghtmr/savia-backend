import type { TransactionClient } from './pg-transaction.js';
import type { WorkspaceInvitation } from './workspace-invitation.port.js';
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

  public async listInvitations(
    client: TransactionClient,
    workspaceId: string,
    cursor: WorkspaceCursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceInvitation[]> {
    const result = await client.query<WorkspaceInvitationRow>(
      `select invitation.id::text,
              invitation.email,
              invitation.role,
              case when invitation.status = 'pending' and invitation.expires_at <= now()
                   then 'expired' else invitation.status end as status,
              invitation.expires_at as "expiresAt",
              invitation.created_at as "createdAt"
         from public.workspace_invitations invitation
        where invitation.workspace_id = $1
          and (
            $2::timestamptz is null
            or (date_trunc('milliseconds', invitation.created_at), invitation.id) > ($2::timestamptz, $3::uuid)
          )
        order by date_trunc('milliseconds', invitation.created_at), invitation.id
        limit $4`,
      [workspaceId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt:
        row.expiresAt instanceof Date
          ? row.expiresAt.toISOString()
          : String(row.expiresAt),
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
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

  public async hasActiveMember(
    client: TransactionClient,
    workspaceId: string,
    email: string,
  ): Promise<boolean> {
    const result = await client.query<{ hasActiveMember: boolean }>(
      'select public.workspace_email_has_active_member($1::uuid, $2::text) as "hasActiveMember"',
      [workspaceId, email],
    );
    return Boolean(result.rows[0]?.hasActiveMember);
  }

  public async findPendingInvitation(
    client: TransactionClient,
    workspaceId: string,
    email: string,
  ): Promise<{ id: string; isExpired: boolean } | undefined> {
    const result = await client.query<{ id: string; isExpired: boolean }>(
      `select invitation.id::text as id,
              case when invitation.expires_at <= now() then true else false end as "isExpired"
         from public.workspace_invitations invitation
        where invitation.workspace_id = $1
          and lower(invitation.email) = lower($2)
          and invitation.status = 'pending'`,
      [workspaceId, email],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      isExpired: Boolean(row.isExpired),
    };
  }

  public async revokeInvitation(
    client: TransactionClient,
    invitationId: string,
  ): Promise<void> {
    await client.query(
      "update public.workspace_invitations set status = 'revoked' where id = $1 and status = 'pending'",
      [invitationId],
    );
  }

  public async createInvitation(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    email: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceInvitation> {
    const result = await client.query<WorkspaceInvitationRow>(
      `insert into public.workspace_invitations (workspace_id, invited_by, email, role, expires_at)
       values ($1, $2, $3, $4, now() + interval '7 days')
       returning id::text,
                 email,
                 role,
                 case when status = 'pending' and expires_at <= now() then 'expired' else status end as status,
                 expires_at as "expiresAt",
                 created_at as "createdAt"`,
      [workspaceId, subject, email, role],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt:
        row.expiresAt instanceof Date
          ? row.expiresAt.toISOString()
          : String(row.expiresAt),
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
    };
  }
}

interface WorkspaceMembershipRow
  extends WorkspaceMembershipRecord,
    Record<string, unknown> {}

interface WorkspaceInvitationRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly expiresAt: Date | string;
  readonly createdAt: Date | string;
}
