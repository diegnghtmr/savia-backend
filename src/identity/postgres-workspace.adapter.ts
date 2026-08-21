import type { TransactionClient } from './pg-transaction.js';
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
