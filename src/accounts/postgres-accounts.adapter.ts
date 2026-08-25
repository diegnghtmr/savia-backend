import type { TransactionClient } from '../identity/pg-transaction.js';
import type { Account, AccountCursor, AccountStatus } from './accounts.port.js';
import type { AccountsStore } from './accounts.service.js';

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
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly version: number;
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
  ): Promise<readonly Account[]> {
    // The cursor carries millisecond-precision timestamps while timestamptz
    // stores microseconds. date_trunc('milliseconds', ...) appears on BOTH
    // sides of the keyset predicate AND in the order by; without it a row at
    // created_at .000100 sorts after a cursor stamped .000000 and repeats on
    // the next page (this exact defect shipped once in C5 slice 6).
    //
    // workspace_id equality drives the (workspace_id, created_at, id) index
    // prefix; ordering by the truncated expression trades the ordered scan for
    // boundary correctness, which is the cheaper side of that trade.
    const conditions = ['a.workspace_id = $1'];
    const values: unknown[] = [workspaceId];
    if (cursor !== undefined) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(date_trunc('milliseconds', a.created_at), a.id)` +
          ` > (date_trunc('milliseconds', $${values.length - 1}::timestamptz), $${values.length})`,
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
       a.version
  from public.accounts a
 where ${conditions.join('\n   and ')}
 order by date_trunc('milliseconds', a.created_at), a.id
 limit $${values.length}`;
    const result = await client.query<AccountRow>(sql, values);
    return result.rows.map((row) => ({
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
    }));
  }
}
