import { enforceDeferredConstraints } from '../platform/deferred-constraints.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import { negateAmountMinor } from '../platform/amount-minor.js';
import { fundSavedAmountSql, lockFund } from '../platform/fund-savings.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { calculateRecommendedMonthlyContribution } from './fund-derivation.js';
import type {
  CreateFundContributionRequest,
  CreateFundRequest,
  CreateFundWithdrawalRequest,
  Fund,
  FundAccountRecord,
  FundDetail,
  FundItem,
  FundListQuery,
  FundStore,
  FundTransaction,
  UpdateFundRequest,
} from './fund.port.js';

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
  readonly objective?: string | null;
  readonly responsibleMemberIds?: string[];
  readonly bookedAt?: string;
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

  public async lockFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<void> {
    await lockFund(client, workspaceId, id);
  }

  public async findFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Fund | undefined> {
    const row = await this.findFundRow(client, workspaceId, id);
    return row && mapFund(row);
  }

  public async readFundDetail(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<{ fund: FundDetail; version: number } | undefined> {
    const row = await this.findFundRow(client, workspaceId, id, true);
    if (!row) return undefined;
    const { version, createdAt, updatedAt, ...fund } = mapFund(row);
    // The version avoids an ABA even if an edit restores the same metadata.
    const body = {
      ...fund,
      objective: row.objective ?? null,
      responsibleMemberIds: row.responsibleMemberIds ?? [],
    };
    const fingerprint = computeRequestFingerprint({
      version,
      createdAt,
      updatedAt,
      ...body,
    });
    return { fund: { ...body, etag: `"${fingerprint}"` }, version };
  }

  public async hasActiveMembers(
    client: TransactionClient,
    workspaceId: string,
    ids: readonly string[],
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const result = await client.query<{ valid: boolean }>(
      `select count(*) = cardinality($2::uuid[]) as valid
       from public.workspace_member_roster($1::uuid)
       where status = 'active' and membership_id = any($2::uuid[])`,
      [workspaceId, ids],
    );
    return result.rows[0]?.valid === true;
  }

  public async updateFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    command: UpdateFundRequest,
    version: number,
  ): Promise<boolean> {
    const result = await client.query(
      `update public.funds f set
         name = coalesce($3::jsonb ->> 'name', f.name),
         objective = case when $3::jsonb ? 'objective' then $3::jsonb ->> 'objective' else f.objective end,
         target_amount_minor = coalesce(($3::jsonb #>> '{targetAmount,amountMinor}')::bigint, f.target_amount_minor),
         target_date = case when $3::jsonb ? 'targetDate' then ($3::jsonb ->> 'targetDate')::date else f.target_date end,
         linked_account_id = case when $3::jsonb ? 'linkedAccountId' then ($3::jsonb ->> 'linkedAccountId')::uuid else f.linked_account_id end,
         responsible_member_ids = coalesce($4::uuid[], f.responsible_member_ids),
         version = f.version + 1,
         updated_at = now()
       where f.workspace_id = $1::uuid and f.id = $2::uuid and f.version = $5::integer
       returning f.id`,
      [
        workspaceId,
        id,
        JSON.stringify(command),
        command.responsibleMemberIds ?? null,
        version,
      ],
    );
    return result.rows.length === 1;
  }

  private async findFundRow(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    effective = false,
  ): Promise<FundRow | undefined> {
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
  ${fundSavedAmountSql(effective)} as "currentAmountMinor"
  ${effective ? ', f.objective, f.responsible_member_ids as "responsibleMemberIds", statement_timestamp()::text as "bookedAt"' : ''}
from public.funds f
where f.workspace_id = $1::uuid
  and f.id = $2::uuid`;

    const result = await client.query<FundRow>(sql, [workspaceId, id]);
    return result.rows[0];
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
  ${fundSavedAmountSql()} as "currentAmountMinor"
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
    return this.writeMovement(
      client,
      workspaceId,
      subject,
      fund,
      command,
      'fund_contribution',
    );
  }

  public async withdrawFromFund(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    fund: Fund,
    command: CreateFundWithdrawalRequest,
  ): Promise<FundTransaction | undefined> {
    // The fund lock is already held. Read the effective savings snapshot and timestamp together.
    const row = await this.findFundRow(client, workspaceId, fund.id, true);
    if (!row?.bookedAt || row.currentAmountMinor === undefined) {
      throw new Error('Fund savings could not be read under lock.');
    }
    if (BigInt(row.currentAmountMinor) < BigInt(command.amount.amountMinor)) {
      return undefined;
    }
    return this.writeMovement(
      client,
      workspaceId,
      subject,
      fund,
      { ...command, occurredAt: row.bookedAt, notes: command.reason },
      'adjustment',
    );
  }

  private async writeMovement(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    fund: Fund,
    command: CreateFundContributionRequest,
    type: 'fund_contribution' | 'adjustment',
  ): Promise<FundTransaction> {
    const accountMinor =
      type === 'adjustment'
        ? command.amount.amountMinor
        : negateAmountMinor(command.amount.amountMinor);
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
  $8,
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
      accountMinor,
      command.amount.currency,
      command.occurredAt,
      command.notes ?? null,
      subject,
      type,
    ];

    const txnResult = await client.query<TransactionRow>(txnSql, txnValues);
    const txnRow = txnResult.rows[0];
    if (!txnRow) {
      throw new Error('Created transaction row could not be read.');
    }

    // The external posting has the opposite sign to the account posting.
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
      accountMinor,
      command.amount.currency,
      type === 'adjustment' ? command.occurredAt : txnRow.occurredAt,
      negateAmountMinor(accountMinor),
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
