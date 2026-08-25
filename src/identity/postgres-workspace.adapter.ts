import type { Cursor } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  WorkspaceCreateCommand,
  WorkspaceUpdateCommand,
} from './workspace-command.js';
import type { WorkspaceMemberStatus, WorkspaceRole } from './workspace.port.js';
import type {
  WorkspaceItem,
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

  public async createWorkspace(
    client: TransactionClient,
    subject: string,
    command: WorkspaceCreateCommand,
  ): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await client.query(
      `insert into public.workspaces (id, name, kind, base_currency, created_by)
values ($1, $2, $3, $4, $5)`,
      [id, command.name, command.kind, command.baseCurrency, subject],
    );
    return { id };
  }

  public async createMembership(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    role: WorkspaceRole,
    status: WorkspaceMemberStatus,
  ): Promise<void> {
    await client.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
values ($1, $2, $3, $4)`,
      [workspaceId, subject, role, status],
    );
  }

  public async listWorkspaces(
    client: TransactionClient,
    subject: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly WorkspaceItem[]> {
    const result = await client.query<WorkspaceListRow>(
      cursor === undefined
        ? `select w.id::text,
                  w.name,
                  w.kind,
                  w.base_currency as "baseCurrency",
                  m.role,
                  w.created_at as "createdAt",
                  w.version,
                  to_char(w.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
             from public.workspaces w
             join public.workspace_memberships m on m.workspace_id = w.id and m.profile_id = $1
            order by w.created_at, w.id
            limit $2`
        : `select w.id::text,
                  w.name,
                  w.kind,
                  w.base_currency as "baseCurrency",
                  m.role,
                  w.created_at as "createdAt",
                  w.version,
                  to_char(w.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
             from public.workspaces w
             join public.workspace_memberships m on m.workspace_id = w.id and m.profile_id = $1
            where (w.created_at, w.id) > ($2::timestamptz, $3::uuid)
            order by w.created_at, w.id
            limit $4`,
      cursor === undefined
        ? [subject, limit]
        : [subject, cursor.createdAt, cursor.id, limit],
    );
    return result.rows.map((row) => ({
      workspace: {
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
      },
      cursorAt: row.cursorAt,
    }));
  }

  public async update(
    client: TransactionClient,
    workspaceId: string,
    command: WorkspaceUpdateCommand,
    expectedVersion?: number | readonly number[],
  ): Promise<WorkspaceRecord | undefined> {
    const versions =
      typeof expectedVersion === 'number'
        ? [expectedVersion]
        : (expectedVersion ?? null);
    const values = [
      workspaceId,
      command.name ?? null,
      command.baseCurrency ?? null,
      versions,
    ];
    const result = await client.query<WorkspaceRow>(
      `update public.workspaces
   set name = coalesce($2, name),
       base_currency = coalesce($3, base_currency),
       version = version + 1
 where id = $1
   and ($4::integer[] is null or version = any($4::integer[]))
returning id::text, name, kind, base_currency as "baseCurrency",
          created_at as "createdAt", version`,
      values,
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

  public async deleteWorkspace(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<number> {
    const result = await client.query(
      'delete from public.workspaces where id = $1',
      [workspaceId],
    );
    return result.rowCount ?? 0;
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
  readonly cursorAt: string;
}
