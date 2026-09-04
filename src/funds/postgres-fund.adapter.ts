import { enforceDeferredConstraints } from '../platform/deferred-constraints.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { calculateRecommendedMonthlyContribution } from './fund-derivation.js';
import type {
  CreateFundContributionRequest,
  CreateFundRequest,
  Fund,
  FundAccountRecord,
  FundItem,
  FundListQuery,
  FundStore,
  FundTransaction,
} from './fund.port.js';

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
  if (typeof value === 'string') {
    return value;
  }
  throw new TypeError(
    `Expected Date or string from database timestamp column, got ${typeof value}`,
  );
}

interface FundRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly currency: string;
  readonly targetAmountMinor: string;
  readonly targetDate: string | null;
  readonly linkedAccountId: string | null;
  readonly status: Fund['status'];
  readonly version: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly currentAmountMinor?: string;
  readonly cursorAt?: string;
}

interface TransactionRow extends Record<string, unknown> {
  readonly id: string;
  readonly accountId: string;
  readonly type: string;
  readonly status: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: Date | string;
  readonly description: string | null;
  readonly notes: string | null;
  readonly categoryId: string | null;
  readonly payeeId: string | null;
  readonly receiptId: string | null;
  readonly reconciliationId: string | null;
  readonly tagIds: string[] | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly version: number;
}

function mapFund(row: FundRow): Fund {
  const currentAmountMinor = String(row.currentAmountMinor ?? '0');
  const targetAmountMinor = String(row.targetAmountMinor);
  const targetDate = row.targetDate ?? null;
  const linkedAccountId = row.linkedAccountId ?? null;

  const recommended = calculateRecommendedMonthlyContribution({
    targetAmountMinor,
    currentAmountMinor,
    currency: row.currency,
    targetDate,
  });

  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    targetAmount: {
      amountMinor: targetAmountMinor,
      currency: row.currency,
    },
    currentAmount: {
      amountMinor: currentAmountMinor,
      currency: row.currency,
    },
    targetDate,
    linkedAccountId,
    ...(recommended !== undefined
      ? { recommendedMonthlyContribution: recommended }
      : {}),
    status: row.status,
    version: Number(row.version),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PostgresFundAdapter implements FundStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    return result.rows[0]?.role ?? undefined;
  }

  public async lockAndReadAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<FundAccountRecord | undefined> {
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountId.toLowerCase()],
    );

    const result = await client.query<{ status: string; currency: string }>(
      'select a.status, a.currency from public.accounts a where a.workspace_id = $1::uuid and a.id = $2::uuid',
      [workspaceId, accountId],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      status: row.status,
      currency: row.currency,
    };
  }

  public async createFund(
    client: TransactionClient,
    workspaceId: string,
    command: CreateFundRequest,
  ): Promise<Fund> {
    const sql = `
insert into public.funds (
  workspace_id,
  name,
  currency,
  target_amount_minor,
  target_date,
  linked_account_id
)
values (
  $1::uuid,
  $2,
  $3,
  $4::bigint,
  $5::date,
  $6::uuid
)
returning
  id::text,
  workspace_id::text as "workspaceId",
  name,
  currency,
  target_amount_minor as "targetAmountMinor",
  to_char(target_date, 'YYYY-MM-DD') as "targetDate",
  linked_account_id::text as "linkedAccountId",
  status,
  version,
  created_at as "createdAt",
  updated_at as "updatedAt"`;

    const values = [
      workspaceId,
      command.name,
      command.currency,
      command.targetAmount.amountMinor,
      command.targetDate ?? null,
      command.linkedAccountId ?? null,
    ];

    const result = await client.query<FundRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Created fund row could not be read.');
    }
    return mapFund({ ...row, currentAmountMinor: '0' });
  }

  public async findFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Fund | undefined> {
    const sql = `
select
  f.id::text,
  f.workspace_id::text as "workspaceId",
  f.name,
  f.currency,
  f.target_amount_minor as "targetAmountMinor",
  to_char(f.target_date, 'YYYY-MM-DD') as "targetDate",
  f.linked_account_id::text as "linkedAccountId",
  f.status,
  f.version,
  f.created_at as "createdAt",
  f.updated_at as "updatedAt",
  coalesce(
    (
      select sum(p.amount_minor)
      from public.fund_contributions fc
      join public.ledger_postings p
        on p.workspace_id = fc.workspace_id
       and p.transaction_id = fc.transaction_id
      where fc.workspace_id = f.workspace_id
        and fc.fund_id = f.id
        and p.account_id is not null
        and p.currency = f.currency
        and p.status in ('confirmed', 'reconciled')
    ),
    0
  )::text as "currentAmountMinor"
from public.funds f
where f.workspace_id = $1::uuid
  and f.id = $2::uuid`;

    const result = await client.query<FundRow>(sql, [workspaceId, id]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return mapFund(row);
  }

  public async listFunds(
    client: TransactionClient,
    query: FundListQuery,
    limit: number,
  ): Promise<readonly FundItem[]> {
    const sql = `
select
  f.id::text,
  f.workspace_id::text as "workspaceId",
  f.name,
  f.currency,
  f.target_amount_minor as "targetAmountMinor",
  to_char(f.target_date, 'YYYY-MM-DD') as "targetDate",
  f.linked_account_id::text as "linkedAccountId",
  f.status,
  f.version,
  f.created_at as "createdAt",
  f.updated_at as "updatedAt",
  to_char(f.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
  coalesce(
    (
      select sum(p.amount_minor)
      from public.fund_contributions fc
      join public.ledger_postings p
        on p.workspace_id = fc.workspace_id
       and p.transaction_id = fc.transaction_id
      where fc.workspace_id = f.workspace_id
        and fc.fund_id = f.id
        and p.account_id is not null
        and p.currency = f.currency
        and p.status in ('confirmed', 'reconciled')
    ),
    0
  )::text as "currentAmountMinor"
from public.funds f
where f.workspace_id = $1::uuid
  and ($2::timestamptz is null or (f.created_at, f.id) > ($2::timestamptz, $3::uuid))
order by f.created_at asc, f.id asc
limit $4`;

    const values = [
      query.workspaceId,
      query.cursor?.createdAt ?? null,
      query.cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<FundRow>(sql, values);
    return result.rows.map((row) => ({
      fund: mapFund(row),
      cursorAt: row.cursorAt ?? '',
    }));
  }

  public async contributeToFund(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    fund: Fund,
    command: CreateFundContributionRequest,
  ): Promise<FundTransaction> {
    // 1. Insert transaction row with type = 'fund_contribution'
    const txnSql = `
insert into public.transactions (
  workspace_id,
  account_id,
  type,
  status,
  amount_minor,
  currency,
  occurred_at,
  notes,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  'fund_contribution',
  'confirmed',
  $3::bigint,
  $4,
  $5::timestamptz,
  $6,
  $7::uuid
)
returning
  id::text,
  account_id::text as "accountId",
  type,
  status,
  amount_minor as "amountMinor",
  currency,
  occurred_at as "occurredAt",
  description,
  notes,
  category_id::text as "categoryId",
  payee_id::text as "payeeId",
  receipt_id::text as "receiptId",
  reconciliation_id::text as "reconciliationId",
  tag_ids as "tagIds",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;

    const txnValues = [
      workspaceId,
      command.accountId,
      command.amount.amountMinor,
      command.amount.currency,
      command.occurredAt,
      command.notes ?? null,
      subject,
    ];

    const txnResult = await client.query<TransactionRow>(txnSql, txnValues);
    const txnRow = txnResult.rows[0];
    if (!txnRow) {
      throw new Error('Created transaction row could not be read.');
    }

    // 2. Insert balanced pair of ledger postings:
    //    account leg (leg_kind = 'account', account_id set, amount_minor positive)
    //    counter leg (leg_kind = 'external', account_id null, amount_minor negated)
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
  ($1::uuid, $2::uuid, $3::uuid, 'account', $4::bigint, $5, 'confirmed', $6),
  ($1::uuid, $2::uuid, null, 'external', $7::bigint, $5, 'confirmed', $6)`;

    const postingsValues = [
      workspaceId,
      txnRow.id,
      command.accountId,
      command.amount.amountMinor,
      command.amount.currency,
      txnRow.occurredAt,
      negateAmountMinor(command.amount.amountMinor),
    ];

    await client.query(postingsSql, postingsValues);

    // 3. Insert fund_contributions link row
    const linkSql = `
insert into public.fund_contributions (
  workspace_id,
  fund_id,
  transaction_id
)
values (
  $1::uuid,
  $2::uuid,
  $3::uuid
)`;

    await client.query(linkSql, [workspaceId, fund.id, txnRow.id]);

    // 4. Enforce deferred constraints before commit
    await enforceDeferredConstraints(client);

    return {
      id: txnRow.id,
      type: txnRow.type,
      status: txnRow.status,
      accountId: txnRow.accountId,
      amount: {
        amountMinor: String(txnRow.amountMinor),
        currency: txnRow.currency,
      },
      occurredAt: toIso(txnRow.occurredAt),
      categoryId: txnRow.categoryId,
      payeeId: txnRow.payeeId,
      description: txnRow.description,
      notes: txnRow.notes,
      tagIds: Array.isArray(txnRow.tagIds) ? txnRow.tagIds : [],
      receiptId: txnRow.receiptId,
      reconciliationId: txnRow.reconciliationId,
      createdAt: toIso(txnRow.createdAt),
      updatedAt: toIso(txnRow.updatedAt),
      version: Number(txnRow.version),
    };
  }
}
