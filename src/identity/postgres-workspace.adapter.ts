import type { TransactionClient } from './pg-transaction.js';
import type {
  Workspace,
  WorkspaceCursor,
  WorkspaceRole,
} from './workspace.port.js';
import type {
  WorkspaceMembershipRecord,
  WorkspaceRecord,
  WorkspaceStore,
} from './workspace.service.js';

export class PostgresWorkspaceAdapter implements WorkspaceStore {
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

  public async readWorkspace(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<WorkspaceRecord | undefined> {
    const result = await client.query<WorkspaceRow>(
      'select id::text, name, kind, base_currency as "baseCurrency", created_at as "createdAt", version from public.workspaces where id = $1',
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseCurrency: row.baseCurrency,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      version: row.version,
    };
  }

  public async listWorkspaces(
    client: TransactionClient,
    subject: string,
    cursor: WorkspaceCursor | undefined,
    limit: number,
  ): Promise<readonly Workspace[]> {
    const result = await client.query<WorkspaceListRow>(
      cursor === undefined
        ? 'select w.id::text, w.name, w.kind, w.base_currency as "baseCurrency", m.role, w.created_at as "createdAt", w.version from public.workspaces w join public.workspace_memberships m on m.workspace_id = w.id and m.profile_id = $1 order by w.created_at, w.id limit $2'
        : 'select w.id::text, w.name, w.kind, w.base_currency as "baseCurrency", m.role, w.created_at as "createdAt", w.version from public.workspaces w join public.workspace_memberships m on m.workspace_id = w.id and m.profile_id = $1 where (w.created_at, w.id) > ($2, $3) order by w.created_at, w.id limit $4',
      cursor === undefined
        ? [subject, limit]
        : [subject, cursor.createdAt, cursor.id, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseCurrency: row.baseCurrency,
      role: row.role,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      version: row.version,
    }));
  }
}

interface WorkspaceMembershipRow
  extends WorkspaceMembershipRecord,
    Record<string, unknown> {}

interface WorkspaceRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceRecord['kind'];
  readonly baseCurrency: string;
  readonly createdAt: Date | string;
  readonly version: number;
}

interface WorkspaceListRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceRecord['kind'];
  readonly baseCurrency: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date | string;
  readonly version: number;
}
