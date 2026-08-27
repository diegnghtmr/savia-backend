import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  Account,
  AccountBalance,
  AccountCursor,
  AccountStatus,
  CreateAccountCommand,
  UpdateAccountCommand,
} from './accounts.port.js';
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

// Defence in depth for the counter-leg. The command validator already refuses
// amounts whose negation would leave int8, but this function is what actually
// mints the external leg, and a caller that skipped validation would otherwise
// hand PostgreSQL 9223372036854775808 and get SQLSTATE 22003 mid-write. Failing
// here names the cause; failing there names a row.
const INT8_MAX = 9223372036854775807n;

export function negateAmountMinor(amountMinor: string): string {
  if (amountMinor === '0' || amountMinor === '-0') {
    return '0';
  }
  if (BigInt(amountMinor) < -INT8_MAX) {
    throw new RangeError(
      `amountMinor ${amountMinor} cannot be negated within int8; its counter-leg would overflow`,
    );
  }
  if (amountMinor.startsWith('-')) {
    return amountMinor.slice(1);
  }
  return `-${amountMinor}`;
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

  public async readWorkspaceBaseCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [workspaceId.toLowerCase()],
    );
    const result = await client.query<{ base_currency: string }>(
      'select base_currency from public.workspaces where id = $1::uuid',
      [workspaceId],
    );
    const baseCurrency = result.rows[0]?.base_currency;
    return typeof baseCurrency === 'string' ? baseCurrency : undefined;
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

  public async createAccount(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateAccountCommand,
  ): Promise<Account> {
    const sql = `
insert into public.accounts (
  workspace_id,
  name,
  type,
  currency,
  institution,
  masked_number,
  description,
  include_in_net_worth,
  created_by
)
values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid)
returning
  id::text,
  name,
  type,
  currency,
  status,
  institution,
  masked_number as "maskedNumber",
  description,
  color_token as "colorToken",
  icon,
  include_in_net_worth as "includeInNetWorth",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;
    const values = [
      workspaceId,
      command.name,
      command.type,
      command.currency,
      command.institution ?? null,
      command.maskedNumber ?? null,
      command.description ?? null,
      command.includeInNetWorth,
      subject,
    ];
    const result = await client.query<AccountRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Created account row could not be read.');
    }

    if (
      command.openingBalance !== undefined &&
      command.openingBalance !== null
    ) {
      const transactionSql = `
insert into public.transactions (
  workspace_id,
  account_id,
  type,
  status,
  amount_minor,
  currency,
  occurred_at,
  description,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  'adjustment',
  'confirmed',
  $3,
  $4,
  coalesce(($5::date)::timestamp at time zone 'utc', now()),
  'Opening balance',
  $6::uuid
)
returning id::text, occurred_at`;

      const transactionValues = [
        workspaceId,
        row.id,
        command.openingBalance.amountMinor,
        command.openingBalance.currency,
        command.openingBalanceDate ?? null,
        subject,
      ];

      const txnResult = await client.query<{ id: string; occurred_at: Date }>(
        transactionSql,
        transactionValues,
      );
      const txnRow = txnResult.rows[0];
      if (!txnRow) {
        throw new Error(
          'Created opening balance transaction row could not be read.',
        );
      }

      const postingsSql = `
insert into public.ledger_postings (
  workspace_id,
  transaction_id,
  account_id,
  leg_kind,
  amount_minor,
  currency,
  status,
  occurred_at
)
values
  ($1::uuid, $2::uuid, $3::uuid, 'account', $4, $5, 'confirmed', $6),
  ($1::uuid, $2::uuid, null, 'external', $7, $5, 'confirmed', $6)`;

      const postingsValues = [
        workspaceId,
        txnRow.id,
        row.id,
        command.openingBalance.amountMinor,
        command.openingBalance.currency,
        txnRow.occurred_at,
        negateAmountMinor(command.openingBalance.amountMinor),
      ];

      await client.query(postingsSql, postingsValues);
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

  public async updateAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    command: UpdateAccountCommand,
    expectedVersions?: number | readonly number[],
  ): Promise<Account | undefined> {
    const setClauses: string[] = [
      'updated_at = now()',
      'version = version + 1',
    ];
    const values: unknown[] = [workspaceId, accountId];

    if (command.name !== undefined) {
      values.push(command.name);
      setClauses.push(`name = $${values.length}`);
    }
    if ('institution' in command && command.institution !== undefined) {
      values.push(command.institution);
      setClauses.push(`institution = $${values.length}`);
    }
    if ('maskedNumber' in command && command.maskedNumber !== undefined) {
      values.push(command.maskedNumber);
      setClauses.push(`masked_number = $${values.length}`);
    }
    if ('description' in command && command.description !== undefined) {
      values.push(command.description);
      setClauses.push(`description = $${values.length}`);
    }
    if (command.includeInNetWorth !== undefined) {
      values.push(command.includeInNetWorth);
      setClauses.push(`include_in_net_worth = $${values.length}`);
    }
    if (command.status !== undefined) {
      values.push(command.status);
      setClauses.push(`status = $${values.length}`);
    }

    const versions =
      typeof expectedVersions === 'number'
        ? [expectedVersions]
        : (expectedVersions ?? null);
    values.push(versions);
    const versionParamIndex = values.length;

    const sql = `
update public.accounts
   set ${setClauses.join(',\n       ')}
 where workspace_id = $1::uuid
   and id = $2::uuid
   and ($${versionParamIndex}::integer[] is null or version = any($${versionParamIndex}::integer[]))
returning
  id::text,
  name,
  type,
  currency,
  status,
  institution,
  masked_number as "maskedNumber",
  description,
  color_token as "colorToken",
  icon,
  include_in_net_worth as "includeInNetWorth",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;

    const result = await client.query<AccountRow>(sql, values);
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

  public async readAccountBalance(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    asOf?: string,
  ): Promise<AccountBalance | undefined> {
    // 1. Account existence and currency lookup scoped strictly by workspace_id
    const accountSql = `
select a.currency
  from public.accounts a
 where a.workspace_id = $1::uuid
   and a.id = $2::uuid`;
    const accountResult = await client.query<{ currency: string }>(accountSql, [
      workspaceId,
      accountId,
    ]);
    const accountRow = accountResult.rows[0];
    if (!accountRow) {
      return undefined;
    }

    // 2. Single-table bucket aggregation query on ledger_postings using covering index
    const balanceSql = `
select
  coalesce(sum(amount_minor) filter (where status in ('confirmed', 'reconciled')), 0)::text as "nativeBalance",
  coalesce(sum(amount_minor) filter (where status = 'pending'), 0)::text as "pendingBalance",
  coalesce(sum(amount_minor) filter (where status = 'reconciled'), 0)::text as "reconciledBalance",
  to_char(coalesce($3::timestamptz, now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "effectiveAsOf"
  from public.ledger_postings
 where workspace_id = $1::uuid
   and account_id = $2::uuid
   and occurred_at <= coalesce($3::timestamptz, now())`;

    const balanceResult = await client.query<{
      nativeBalance: string;
      pendingBalance: string;
      reconciledBalance: string;
      effectiveAsOf: string;
    }>(balanceSql, [workspaceId, accountId, asOf ?? null]);

    const balanceRow = balanceResult.rows[0];
    if (!balanceRow) {
      throw new Error('Account balance aggregate query returned no row.');
    }

    const currency = accountRow.currency;
    const asOfIso = balanceRow.effectiveAsOf;
    const rateDate = asOfIso.slice(0, 10);

    return {
      accountId,
      nativeBalance: {
        amountMinor: balanceRow.nativeBalance,
        currency,
      },
      pendingBalance: {
        amountMinor: balanceRow.pendingBalance,
        currency,
      },
      reconciledBalance: {
        amountMinor: balanceRow.reconciledBalance,
        currency,
      },
      baseCurrencyEquivalent: {
        original: {
          amountMinor: balanceRow.nativeBalance,
          currency,
        },
        converted: {
          amountMinor: balanceRow.nativeBalance,
          currency,
        },
        rate: '1',
        rateDate,
        rateSource: 'identity',
      },
      asOf: asOfIso,
    };
  }

  public async hasUnsettledTransactions(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<boolean> {
    const sql = `
select 1
  from public.transactions
 where workspace_id = $1::uuid
   and account_id = $2::uuid
   and status in ('draft', 'pending')
 limit 1`;
    const result = await client.query(sql, [workspaceId, accountId]);
    return result.rows.length > 0;
  }

  public async closeAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    expectedVersions?: number | readonly number[],
  ): Promise<Account | undefined> {
    const versions =
      typeof expectedVersions === 'number'
        ? [expectedVersions]
        : (expectedVersions ?? null);

    const sql = `
update public.accounts
   set status = 'closed',
       closed_at = now(),
       updated_at = now(),
       version = version + 1
 where workspace_id = $1::uuid
   and id = $2::uuid
   and ($3::integer[] is null or version = any($3::integer[]))
returning
  id::text,
  name,
  type,
  currency,
  status,
  institution,
  masked_number as "maskedNumber",
  description,
  color_token as "colorToken",
  icon,
  include_in_net_worth as "includeInNetWorth",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;

    const result = await client.query<AccountRow>(sql, [
      workspaceId,
      accountId,
      versions,
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
