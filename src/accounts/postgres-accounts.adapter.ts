import type { TransactionClient } from '../platform/pg-transaction.js';
import type { Account, AccountCursor, AccountStatus } from './accounts.port.js';
import type { AccountItem, AccountsStore } from './accounts.service.js';

interface AccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly type: Account['type'];
  readonly currency: string;
  readonly status: AccountStatus;
  readonly institution: string | null;
  readonly maskedNumber: string | null;
  readonly description: string | null;
  readonly colorToken: string | null;
  readonly icon: string | null;
  readonly includeInNetWorth: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
  readonly cursorAt: string;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new TypeError(
    `Expected Date instance from database timestamp column, got ${typeof value}`,
  );
}

export class PostgresAccountsAdapter implements AccountsStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    // Same security-definer helper the accounts RLS policies route through
    // (202608240002). It returns NULL for a non-member AND for an absent
    // workspace, which is exactly the collapse listAccounts needs.
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    const role = result.rows[0]?.role;
    return typeof role === 'string' ? role : undefined;
  }

  public async listAccounts(
    client: TransactionClient,
    workspaceId: string,
    cursor: AccountCursor | undefined,
    limit: number,
    status: AccountStatus | undefined,
  ): Promise<readonly AccountItem[]> {
    // Keyset pagination matches the accounts_workspace_keyset_idx index
    // on (workspace_id, created_at, id) directly.
    // The cursor timestamp is serialized at full microsecond precision via
    // to_char(... at time zone 'utc', ...), avoiding server timezone dependence
    // while allowing lossless round-tripping through timestamptz.
    const conditions = ['a.workspace_id = $1'];
    const values: unknown[] = [workspaceId];
    if (cursor !== undefined) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(a.created_at, a.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    if (status !== undefined) {
      values.push(status);
      conditions.push(`a.status = $${values.length}`);
    }
    values.push(limit);
    const sql = `
select a.id::text,
       a.name,
       a.type,
       a.currency,
       a.status,
       a.institution,
       a.masked_number as "maskedNumber",
       a.description,
       a.color_token as "colorToken",
       a.icon,
       a.include_in_net_worth as "includeInNetWorth",
       a.created_at as "createdAt",
       a.updated_at as "updatedAt",
       a.version,
       to_char(a.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
  from public.accounts a
 where ${conditions.join('\n   and ')}
 order by a.created_at, a.id
 limit $${values.length}`;
    const result = await client.query<AccountRow>(sql, values);
    return result.rows.map((row) => ({
      account: {
        id: row.id,
        name: row.name,
        type: row.type,
        currency: row.currency,
        status: row.status,
        institution: row.institution,
        maskedNumber: row.maskedNumber,
        description: row.description,
        colorToken: row.colorToken,
        icon: row.icon,
        includeInNetWorth: row.includeInNetWorth,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        version: row.version,
      },
      cursorAt: row.cursorAt,
    }));
  }

  public async readAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<Account | undefined> {
    // The account lookup is scoped by workspace_id in the SQL predicate itself,
    // not filtered afterward, so a foreign account is indistinguishable from an absent one.
    const sql = `
select a.id::text,
       a.name,
       a.type,
       a.currency,
       a.status,
       a.institution,
       a.masked_number as "maskedNumber",
       a.description,
       a.color_token as "colorToken",
       a.icon,
       a.include_in_net_worth as "includeInNetWorth",
       a.created_at as "createdAt",
       a.updated_at as "updatedAt",
       a.version,
       to_char(a.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
  from public.accounts a
 where a.workspace_id = $1::uuid
   and a.id = $2::uuid`;
    const result = await client.query<AccountRow>(sql, [
      workspaceId,
      accountId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      currency: row.currency,
      status: row.status,
      institution: row.institution,
      maskedNumber: row.maskedNumber,
      description: row.description,
      colorToken: row.colorToken,
      icon: row.icon,
      includeInNetWorth: row.includeInNetWorth,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      version: row.version,
    };
  }
}
