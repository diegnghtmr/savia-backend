import { enforceDeferredConstraints } from '../platform/deferred-constraints.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateDebtPaymentRequest,
  CreateDebtRequest,
  Debt,
  DebtAccountRecord,
  DebtItem,
  DebtListQuery,
  DebtStore,
  DebtTransaction,
} from './debt.port.js';

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

interface DebtRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly currency: string;
  readonly principalMinor: string;
  readonly annualRate: string;
  readonly rateType: Debt['rateType'];
  readonly minimumPaymentMinor: string | null;
  readonly startDate: string | null;
  readonly termMonths: number | null;
  readonly nextPaymentAt: string | null;
  readonly status: Debt['status'];
  readonly version: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly outstandingBalanceMinor?: string;
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

function mapDebt(row: DebtRow): Debt {
  const principalMinor = String(row.principalMinor);
  const outstandingBalanceMinor = String(
    row.outstandingBalanceMinor ?? row.principalMinor,
  );

  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    principal: {
      amountMinor: principalMinor,
      currency: row.currency,
    },
    outstandingBalance: {
      amountMinor: outstandingBalanceMinor,
      currency: row.currency,
    },
    annualRate: row.annualRate,
    ...(row.rateType ? { rateType: row.rateType } : {}),
    ...(row.minimumPaymentMinor != null
      ? {
          minimumPayment: {
            amountMinor: String(row.minimumPaymentMinor),
            currency: row.currency,
          },
        }
      : {}),
    ...(row.nextPaymentAt !== undefined
      ? { nextPaymentAt: row.nextPaymentAt }
      : {}),
    status: row.status,
  };
}

export class PostgresDebtAdapter implements DebtStore {
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
  ): Promise<DebtAccountRecord | undefined> {
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

  public async createDebt(
    client: TransactionClient,
    workspaceId: string,
    command: CreateDebtRequest,
  ): Promise<Debt> {
    const sql = `
insert into public.debts (
  workspace_id,
  name,
  currency,
  principal_minor,
  annual_rate,
  rate_type,
  minimum_payment_minor,
  start_date,
  term_months
)
values (
  $1::uuid,
  $2,
  $3,
  $4::bigint,
  $5::numeric,
  $6,
  $7::bigint,
  $8::date,
  $9::integer
)
returning
  id::text,
  workspace_id::text as "workspaceId",
  name,
  currency,
  principal_minor as "principalMinor",
  annual_rate::text as "annualRate",
  rate_type as "rateType",
  minimum_payment_minor as "minimumPaymentMinor",
  to_char(start_date, 'YYYY-MM-DD') as "startDate",
  term_months as "termMonths",
  to_char(next_payment_at, 'YYYY-MM-DD') as "nextPaymentAt",
  status,
  version,
  created_at as "createdAt",
  updated_at as "updatedAt"`;

    const values = [
      workspaceId,
      command.name,
      command.principal.currency,
      command.principal.amountMinor,
      command.annualRate,
      command.rateType,
      command.minimumPayment?.amountMinor ?? null,
      command.startDate ?? null,
      command.termMonths ?? null,
    ];

    const result = await client.query<DebtRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Created debt row could not be read.');
    }
    return mapDebt({ ...row, outstandingBalanceMinor: row.principalMinor });
  }

  public async findDebt(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Debt | undefined> {
    const sql = `
select
  d.id::text,
  d.workspace_id::text as "workspaceId",
  d.name,
  d.currency,
  d.principal_minor as "principalMinor",
  d.annual_rate::text as "annualRate",
  d.rate_type as "rateType",
  d.minimum_payment_minor as "minimumPaymentMinor",
  to_char(d.start_date, 'YYYY-MM-DD') as "startDate",
  d.term_months as "termMonths",
  to_char(d.next_payment_at, 'YYYY-MM-DD') as "nextPaymentAt",
  d.status,
  d.version,
  d.created_at as "createdAt",
  d.updated_at as "updatedAt",
  greatest(
    0,
    d.principal_minor - coalesce(
      (
        select sum(dp.principal_minor)
        from public.debt_payments dp
        join public.ledger_postings p
          on p.workspace_id = dp.workspace_id
         and p.transaction_id = dp.transaction_id
        where dp.workspace_id = d.workspace_id
          and dp.debt_id = d.id
          and p.account_id is not null
          and p.currency = d.currency
          and p.status in ('confirmed', 'reconciled')
      ),
      0
    )
  )::text as "outstandingBalanceMinor"
from public.debts d
where d.workspace_id = $1::uuid
  and d.id = $2::uuid`;

    const result = await client.query<DebtRow>(sql, [workspaceId, id]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return mapDebt(row);
  }

  public async listDebts(
    client: TransactionClient,
    query: DebtListQuery,
    limit: number,
  ): Promise<readonly DebtItem[]> {
    const sql = `
select
  d.id::text,
  d.workspace_id::text as "workspaceId",
  d.name,
  d.currency,
  d.principal_minor as "principalMinor",
  d.annual_rate::text as "annualRate",
  d.rate_type as "rateType",
  d.minimum_payment_minor as "minimumPaymentMinor",
  to_char(d.start_date, 'YYYY-MM-DD') as "startDate",
  d.term_months as "termMonths",
  to_char(d.next_payment_at, 'YYYY-MM-DD') as "nextPaymentAt",
  d.status,
  d.version,
  d.created_at as "createdAt",
  d.updated_at as "updatedAt",
  to_char(d.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
  greatest(
    0,
    d.principal_minor - coalesce(
      (
        select sum(dp.principal_minor)
        from public.debt_payments dp
        join public.ledger_postings p
          on p.workspace_id = dp.workspace_id
         and p.transaction_id = dp.transaction_id
        where dp.workspace_id = d.workspace_id
          and dp.debt_id = d.id
          and p.account_id is not null
          and p.currency = d.currency
          and p.status in ('confirmed', 'reconciled')
      ),
      0
    )
  )::text as "outstandingBalanceMinor"
from public.debts d
where d.workspace_id = $1::uuid
  and ($2::timestamptz is null or (d.created_at, d.id) > ($2::timestamptz, $3::uuid))
order by d.created_at asc, d.id asc
limit $4`;

    const values = [
      query.workspaceId,
      query.cursor?.createdAt ?? null,
      query.cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<DebtRow>(sql, values);
    return result.rows.map((row) => ({
      debt: mapDebt(row),
      cursorAt: row.cursorAt ?? '',
    }));
  }

  public async createDebtPayment(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    debt: Debt,
    command: CreateDebtPaymentRequest,
  ): Promise<DebtTransaction> {
    // 1. Resolve split invariant amounts:
    // If none of the 3 parts is supplied: totalAmount entirely reduces principal
    // If any part is supplied: parts must sum to total (already enforced by command validator)
    const hasPrincipal =
      command.principalAmount !== undefined &&
      command.principalAmount !== null;
    const hasInterest =
      command.interestAmount !== undefined && command.interestAmount !== null;
    const hasFee =
      command.feeAmount !== undefined && command.feeAmount !== null;

    let principalMinor: string;
    let interestMinor: string;
    let feeMinor: string;

    if (!hasPrincipal && !hasInterest && !hasFee) {
      principalMinor = command.totalAmount.amountMinor;
      interestMinor = '0';
      feeMinor = '0';
    } else {
      principalMinor = hasPrincipal
        ? command.principalAmount!.amountMinor
        : '0';
      interestMinor = hasInterest ? command.interestAmount!.amountMinor : '0';
      feeMinor = hasFee ? command.feeAmount!.amountMinor : '0';
    }

    // 2. Insert transaction row with type = 'debt_payment'
    // Outflow from source account is NEGATIVE
    const txnSql = `
insert into public.transactions (
  workspace_id,
  account_id,
  type,
  status,
  amount_minor,
  currency,
  occurred_at,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  'debt_payment',
  'confirmed',
  $3::bigint,
  $4,
  $5::timestamptz,
  $6::uuid
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
      negateAmountMinor(command.totalAmount.amountMinor),
      command.totalAmount.currency,
      command.occurredAt,
      subject,
    ];

    const txnResult = await client.query<TransactionRow>(txnSql, txnValues);
    const txnRow = txnResult.rows[0];
    if (!txnRow) {
      throw new Error('Created transaction row could not be read.');
    }

    // 3. Insert balanced pair of ledger postings:
    //    account leg (leg_kind = 'account', account_id set, amount_minor negative outflow)
    //    counter leg (leg_kind = 'external', account_id null, amount_minor positive counter-leg)
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
      negateAmountMinor(command.totalAmount.amountMinor),
      command.totalAmount.currency,
      txnRow.occurredAt,
      command.totalAmount.amountMinor,
    ];

    await client.query(postingsSql, postingsValues);

    // 4. Insert debt_payments split link row
    const linkSql = `
insert into public.debt_payments (
  workspace_id,
  debt_id,
  transaction_id,
  principal_minor,
  interest_minor,
  fee_minor
)
values (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::bigint,
  $5::bigint,
  $6::bigint
)`;

    await client.query(linkSql, [
      workspaceId,
      debt.id,
      txnRow.id,
      principalMinor,
      interestMinor,
      feeMinor,
    ]);

    // 5. Enforce deferred constraints before commit
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
