import type { Cursor } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateMcpGrantCommand,
  McpGrant,
  McpGrantStore,
} from './mcp-grant.port.js';
interface Row extends Record<string, unknown> {
  id: string;
  clientName: string;
  scopes: string[];
  workspaceIds: string[];
  accountIds: string[] | null;
  maxWriteAmountMinor: string | null;
  maxWriteCurrency: string | null;
  status: string;
  expiresAt: Date | string | null;
  createdAt: Date | string;
}
function map(row: Row, now = new Date()): McpGrant {
  const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
  return {
    id: row.id,
    clientName: row.clientName,
    scopes: row.scopes,
    workspaceIds: row.workspaceIds,
    ...(row.accountIds ? { accountIds: row.accountIds } : {}),
    maxWriteAmount:
      row.maxWriteAmountMinor === null
        ? null
        : {
            amountMinor: row.maxWriteAmountMinor,
            currency: row.maxWriteCurrency ?? '',
          },
    status:
      row.status === 'active' &&
      expiresAt &&
      expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : (row.status as McpGrant['status']),
    expiresAt: expiresAt?.toISOString() ?? null,
    createdAt: new Date(row.createdAt)
      .toISOString()
      .replace(/\.(\d{3})Z$/, '.$1000Z'),
  };
}
export class PostgresMcpGrantAdapter implements McpGrantStore {
  public createId(): string {
    return crypto.randomUUID();
  }
  public async canMint(
    client: TransactionClient,
    _subject: string,
    scopes: readonly string[],
    workspaceIds: readonly string[],
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(
      'select public.mcp_grant_within_minter_role($1::text[], $2::uuid[]) as allowed',
      [scopes, workspaceIds],
    );
    return result.rows[0]?.allowed === true;
  }
  public async accountsBelongToWorkspaces(
    client: TransactionClient,
    accountIds: readonly string[],
    workspaceIds: readonly string[],
  ): Promise<boolean> {
    const result = await client.query<{ count: string }>(
      'select count(*)::text as count from public.accounts where id = any($1::uuid[]) and workspace_id = any($2::uuid[])',
      [accountIds, workspaceIds],
    );
    return Number(result.rows[0]?.count ?? 0) === accountIds.length;
  }
  public async create(
    client: TransactionClient,
    subject: string,
    id: string,
    command: CreateMcpGrantCommand,
  ): Promise<McpGrant> {
    const r = await client.query<Row>(
      'insert into public.mcp_grants (id, subject_id, client_name, scopes, workspace_ids, account_ids, max_write_amount_minor, max_write_currency, expires_at) values ($1, $2::uuid, $3, $4, $5::uuid[], $6::uuid[], $7, $8, $9) returning id, client_name as "clientName", scopes, workspace_ids as "workspaceIds", account_ids as "accountIds", max_write_amount_minor as "maxWriteAmountMinor", max_write_currency as "maxWriteCurrency", status, expires_at as "expiresAt", created_at as "createdAt"',
      [
        id,
        subject,
        command.clientName,
        command.scopes,
        command.workspaceIds,
        command.accountIds ?? null,
        command.maxWriteAmount?.amountMinor ?? null,
        command.maxWriteAmount?.currency ?? null,
        command.expiresAt === null ? null : new Date(command.expiresAt),
      ],
    );
    return map(r.rows[0]);
  }
  public async list(
    client: TransactionClient,
    _subject: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly McpGrant[]> {
    const result = await client.query<Row>(
      cursor
        ? 'select id, client_name as "clientName", scopes, workspace_ids as "workspaceIds", account_ids as "accountIds", max_write_amount_minor as "maxWriteAmountMinor", max_write_currency as "maxWriteCurrency", status, expires_at as "expiresAt", created_at as "createdAt" from public.mcp_grants where subject_id = nullif(current_setting(\'app.subject_id\', true), \'\')::uuid and (created_at, id) > ($1::timestamptz, $2::uuid) order by created_at, id limit $3'
        : 'select id, client_name as "clientName", scopes, workspace_ids as "workspaceIds", account_ids as "accountIds", max_write_amount_minor as "maxWriteAmountMinor", max_write_currency as "maxWriteCurrency", status, expires_at as "expiresAt", created_at as "createdAt" from public.mcp_grants where subject_id = nullif(current_setting(\'app.subject_id\', true), \'\')::uuid order by created_at, id limit $1',
      cursor ? [cursor.createdAt, cursor.id, limit] : [limit],
    );
    return result.rows.map((row) => map(row));
  }
  public async find(
    client: TransactionClient,
    _subject: string,
    id: string,
  ): Promise<McpGrant | undefined> {
    const result = await client.query<Row>(
      'select id, client_name as "clientName", scopes, workspace_ids as "workspaceIds", account_ids as "accountIds", max_write_amount_minor as "maxWriteAmountMinor", max_write_currency as "maxWriteCurrency", status, expires_at as "expiresAt", created_at as "createdAt" from public.mcp_grants where id = $1::uuid',
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
  public async revoke(
    client: TransactionClient,
    subject: string,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const result = await client.query(
      "update public.mcp_grants set status = 'revoked', revoked_at = $3 where subject_id = $1::uuid and id = $2::uuid and status = 'active' and (expires_at is null or expires_at > $3)",
      [subject, id, now],
    );
    return result.rowCount === 1;
  }
}
