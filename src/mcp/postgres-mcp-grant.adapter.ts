import type { Cursor } from '../platform/cursor.js';
import { ACTIVE_CURRENCIES } from '../platform/field-validation.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { McpProposalIdentity } from '../platform/request-identity.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type {
  CreateMcpGrantCommand,
  McpGrant,
  McpGrantAuthorizer,
  McpGrantCall,
  McpGrantStore,
  McpGrantToolAccess,
  McpWeeklyWindow,
  Money,
} from './mcp-grant.port.js';
import {
  MCP_LOCAL_TIME,
  MCP_MINOR_UNITS,
  parseGrantSchedule,
  parseToolAllowlist,
} from './mcp-grant-restrictions.js';
import { MCP_TOOL_ANNOTATIONS } from './mcp-tools.js';
interface Row extends Record<string, unknown> {
  id: string;
  clientName: string;
  scopes: string[];
  workspaceIds: string[];
  accountIds: string[] | null;
  toolAllowlist: string[];
  schedule: McpWeeklyWindow[];
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
    toolAllowlist: row.toolAllowlist,
    schedule: row.schedule,
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
const grantColumns = `id, client_name as "clientName", scopes,
  workspace_ids as "workspaceIds", account_ids as "accountIds", tool_allowlist as "toolAllowlist", schedule,
  max_write_amount_minor as "maxWriteAmountMinor", max_write_currency as "maxWriteCurrency",
  status, expires_at as "expiresAt", created_at as "createdAt"`;

interface LockedPolicy extends Record<string, unknown> {
  readonly role: string;
  readonly toolAllowlist: unknown;
  readonly schedule: unknown;
  readonly maxWriteAmountMinor: string | null;
  readonly maxWriteCurrency: string | null;
  readonly localDay: number;
  readonly localTime: string;
}

function allowsCall(
  policy: Pick<
    LockedPolicy,
    'toolAllowlist' | 'schedule' | 'localDay' | 'localTime'
  >,
  toolName: string,
  isRead: boolean,
): boolean {
  if (!MCP_LOCAL_TIME.test(policy.localTime)) return false;
  const allowlist = parseToolAllowlist(policy.toolAllowlist);
  if (
    !('value' in allowlist) ||
    !(allowlist.value.length ? allowlist.value.includes(toolName) : isRead)
  )
    return false;
  const schedule = parseGrantSchedule(policy.schedule);
  return (
    'value' in schedule &&
    schedule.value.some(
      ({ dayOfWeek, startTime, endTime }) =>
        dayOfWeek === policy.localDay &&
        startTime <= policy.localTime &&
        policy.localTime < endTime,
    )
  );
}

function validMoney(amount: Money): boolean {
  return (
    amount != null &&
    typeof amount.amountMinor === 'string' &&
    MCP_MINOR_UNITS.test(amount.amountMinor) &&
    ACTIVE_CURRENCIES.has(amount.currency)
  );
}

function withinWriteLimit(
  amounts: readonly Money[],
  policy: LockedPolicy,
): boolean {
  const { maxWriteAmountMinor, maxWriteCurrency } = policy;
  if (maxWriteAmountMinor === null) return maxWriteCurrency === null;
  if (
    typeof maxWriteAmountMinor !== 'string' ||
    !MCP_MINOR_UNITS.test(maxWriteAmountMinor) ||
    !amounts.length ||
    amounts.some(({ currency }) => currency !== maxWriteCurrency)
  )
    return false;
  const limit = BigInt(maxWriteAmountMinor);
  let total = 0n;
  for (const { amountMinor } of amounts) {
    const value = BigInt(amountMinor);
    total += value < 0n ? -value : value;
    if (total > limit) return false;
  }
  return true;
}

function hasLedgerFootprint(
  toolName: string,
  accountCount: number,
  amountCount: number,
): boolean {
  // U3 must resolve amounts and accounts from validated commands/current rows.
  switch (toolName) {
    case 'create_transfer':
    case 'create_cross_currency_transfer':
      return accountCount === 2 && amountCount > 0;
    case 'create_transaction':
    case 'update_transaction':
    case 'void_transaction':
      return accountCount > 0 && amountCount > 0;
    case 'get_account_balance':
      return accountCount === 1;
    default:
      return true;
  }
}

export class PostgresMcpGrantAdapter
  implements McpGrantStore, McpGrantAuthorizer
{
  public async authorizeMcpGrant(
    client: TransactionClient,
    call: McpGrantCall,
  ): Promise<boolean> {
    if (!Array.isArray(call.amounts)) return false;
    return this.authorize(client, call, call.amounts);
  }

  public authorizeMcpProposalReplay(
    client: TransactionClient,
    access: McpGrantToolAccess,
  ): Promise<boolean> {
    return this.authorize(client, access, undefined);
  }

  private async authorize(
    client: TransactionClient,
    { subject, grantId, workspaceId, toolName, accountIds }: McpGrantToolAccess,
    amounts: readonly Money[] | undefined,
  ): Promise<boolean> {
    const tool = MCP_TOOL_ANNOTATIONS.get(toolName);
    if (
      !tool ||
      (amounts === undefined && !tool.requiresApproval) ||
      ![subject, grantId, workspaceId].every(
        (id) => typeof id === 'string' && UUID_PATTERN.test(id),
      ) ||
      !Array.isArray(accountIds)
    )
      return false;
    const accounts = Array.from(accountIds, (id: string) =>
      typeof id === 'string' && UUID_PATTERN.test(id)
        ? id.toLowerCase()
        : undefined,
    );
    const money = amounts && Array.from(amounts);
    if (
      accounts.includes(undefined) ||
      new Set(accounts).size !== accounts.length ||
      (money &&
        (!money.every(validMoney) ||
          !hasLedgerFootprint(toolName, accounts.length, money.length)))
    )
      return false;

    const {
      rows: [policy],
    } = await client.query<LockedPolicy>(
      `select role, tool_allowlist as "toolAllowlist", schedule, max_write_amount_minor as "maxWriteAmountMinor",
              max_write_currency as "maxWriteCurrency", local_day as "localDay", local_time as "localTime"
         from public.locked_mcp_grant_policy($1::uuid, $2::uuid, $3::uuid, $4::text[], $5::uuid[])`,
      [subject, grantId, workspaceId, tool.requiredScopes, accounts],
    );
    if (!policy) return false;
    if (
      tool.riskClass === 'administrative' &&
      policy.role !== 'owner' &&
      policy.role !== 'administrator'
    )
      return false;
    const isRead = tool.riskClass === 'read' && !tool.requiresApproval;
    return (
      allowsCall(policy, toolName, isRead) &&
      (isRead || money === undefined || withinWriteLimit(money, policy))
    );
  }

  public async readDiscoveryWorkspaces(
    client: TransactionClient,
    { subject, grantId }: McpProposalIdentity,
    toolName: string,
  ): Promise<readonly string[]> {
    const tool = MCP_TOOL_ANNOTATIONS.get(toolName);
    if (
      tool?.riskClass !== 'read' ||
      tool.requiresApproval ||
      tool.requiredScopes.length
    )
      return [];
    // Workspace discovery exposes membership metadata, not account data. Unlike
    // workspace-wide financial reads it can ignore the account allowlist.
    const { rows } = await client.query<LockedPolicy & { workspaceId: string }>(
      `select w.id as "workspaceId", g.tool_allowlist as "toolAllowlist", g.schedule,
              extract(isodow from local.wall_time)::integer as "localDay", to_char(local.wall_time, 'HH24:MI') as "localTime"
         from public.mcp_grants g
         join public.workspaces w on w.id = any(g.workspace_ids)
         join pg_timezone_names tz on tz.name = w.timezone
         cross join lateral (select timezone(tz.name, statement_timestamp()) as wall_time) local
        where g.subject_id = $1::uuid and g.id = $2::uuid and g.status = 'active'
          and (g.expires_at is null or g.expires_at > statement_timestamp())
          and public.workspace_actor_active_role(w.id) is not null
          and tz.name not in ('localtime', 'posixrules')
          and tz.name not like 'posix/%' and tz.name not like 'right/%'`,
      [subject, grantId],
    );
    return rows
      .filter((row) => allowsCall(row, toolName, true))
      .map(({ workspaceId }) => workspaceId);
  }

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
    const result = await client.query<{ allowed: boolean }>(
      'select public.mcp_grant_accounts_within_workspaces($1::uuid[], $2::uuid[]) as allowed',
      [accountIds, workspaceIds],
    );
    return result.rows[0]?.allowed === true;
  }
  public async create(
    client: TransactionClient,
    subject: string,
    id: string,
    command: CreateMcpGrantCommand,
  ): Promise<McpGrant> {
    const r = await client.query<Row>(
      `insert into public.mcp_grants (id, subject_id, client_name, scopes, workspace_ids, account_ids,
        max_write_amount_minor, max_write_currency, expires_at, tool_allowlist, schedule)
       values ($1, $2::uuid, $3, $4, $5::uuid[], $6::uuid[], $7, $8, $9, $10::text[], $11::jsonb)
       returning ${grantColumns}`,
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
        command.toolAllowlist,
        JSON.stringify(command.schedule),
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
        ? `select ${grantColumns} from public.mcp_grants where subject_id = nullif(current_setting('app.subject_id', true), '')::uuid and (created_at, id) > ($1::timestamptz, $2::uuid) order by created_at, id limit $3`
        : `select ${grantColumns} from public.mcp_grants where subject_id = nullif(current_setting('app.subject_id', true), '')::uuid order by created_at, id limit $1`,
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
      `select ${grantColumns} from public.mcp_grants where id = $1::uuid`,
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
