import { CURRENCY_RATE_SELECTION_SQL } from '../platform/currency-conversion.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  AccountExistenceRow,
  AccountNativeBalanceRow,
  CreateForecastRecord,
  Forecast,
  ForecastConfidence,
  ForecastPoint,
  ForecastStatus,
  ForecastStore,
  ScenarioRunRowData,
  TransactionFlowRow,
} from './forecast.port.js';

interface ForecastRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly generatedAt: string;
  readonly confidence: string;
  readonly assumptions: readonly string[];
  readonly series: readonly ForecastPoint[];
  readonly method: string;
}

interface ScenarioRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly monthlySavingsCapacityMinor: string;
}

function mapForecast(row: ForecastRow): Forecast {
  return {
    id: row.id,
    status: row.status as ForecastStatus,
    generatedAt: row.generatedAt,
    confidence: row.confidence as ForecastConfidence,
    assumptions: row.assumptions,
    series: row.series,
    method: row.method,
  };
}

export class PostgresForecastAdapter implements ForecastStore {
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

  public async readWorkspaceBaseCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ baseCurrency: string }>(
      'select base_currency as "baseCurrency" from public.workspaces where id = $1::uuid',
      [workspaceId],
    );
    return result.rows[0]?.baseCurrency;
  }

  public async findForecastById(
    client: TransactionClient,
    workspaceId: string,
    forecastId: string,
  ): Promise<Forecast | undefined> {
    const sql = `
select
  id::text,
  status,
  to_char(generated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "generatedAt",
  confidence,
  assumptions,
  series,
  method
from public.forecasts
where workspace_id = $1::uuid and id = $2::uuid`;

    const result = await client.query<ForecastRow>(sql, [
      workspaceId,
      forecastId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return mapForecast(row);
  }

  public async checkAccountsExist(
    client: TransactionClient,
    workspaceId: string,
    accountIds: readonly string[],
  ): Promise<readonly AccountExistenceRow[]> {
    const sql = `
select id::text, status
from public.accounts
where workspace_id = $1::uuid
  and id = any($2::uuid[])`;

    const result = await client.query<AccountExistenceRow>(sql, [
      workspaceId,
      accountIds,
    ]);
    return result.rows;
  }

  public async readOpenAccountIds(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly string[]> {
    const sql = `
select id::text
from public.accounts
where workspace_id = $1::uuid
  and status <> 'closed'
order by id`;

    const result = await client.query<{ id: string }>(sql, [workspaceId]);
    return result.rows.map((row) => row.id);
  }

  public async readAccountNativeBalances(
    client: TransactionClient,
    workspaceId: string,
    accountIds: readonly string[],
  ): Promise<readonly AccountNativeBalanceRow[]> {
    const sql = `
select
  acct.id::text as id,
  acct.currency,
  coalesce(
    sum(posting.amount_minor) filter (
      where posting.currency = acct.currency
        and posting.status in ('confirmed', 'reconciled')
    ),
    0
  )::text as "nativeBalanceMinor"
from public.accounts acct
left join public.ledger_postings posting
  on posting.workspace_id = acct.workspace_id
 and posting.account_id = acct.id
where acct.workspace_id = $1::uuid
  and acct.status <> 'closed'
  and acct.id = any($2::uuid[])
group by acct.id, acct.currency`;

    const result = await client.query<AccountNativeBalanceRow>(sql, [
      workspaceId,
      accountIds,
    ]);
    return result.rows;
  }

  public async readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    accountIds: readonly string[],
  ): Promise<readonly TransactionFlowRow[]> {
    const sql = `
select
  t.id::text as id,
  t.type,
  t.amount_minor::text as "amountMinor",
  t.currency,
  t.occurred_at as "occurredAt"
from public.transactions t
where t.workspace_id = $1::uuid
  and t.status in ('confirmed', 'reconciled')
  and t.account_id = any($4::uuid[])
  and exists (
    select 1
    from public.ledger_postings p
    where p.workspace_id = t.workspace_id
      and p.transaction_id = t.id
      and p.status in ('confirmed', 'reconciled')
      and p.transfer_id is null
  )
  and not exists (
    select 1
    from public.ledger_postings p2
    where p2.workspace_id = t.workspace_id
      and p2.transaction_id = t.id
      and p2.status not in ('confirmed', 'reconciled')
  )
  and (t.occurred_at at time zone 'utc')::date >= $2::date
  and (t.occurred_at at time zone 'utc')::date <= $3::date
  and t.type in ('income', 'expense', 'refund')`;

    const result = await client.query<TransactionFlowRow>(sql, [
      workspaceId,
      from,
      to,
      accountIds,
    ]);
    return result.rows;
  }

  public async findExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    asOf?: Date | null,
  ): Promise<string | undefined> {
    const result = await client.query<{ rate: string }>(
      CURRENCY_RATE_SELECTION_SQL,
      [workspaceId, baseCurrency, quoteCurrency, asOf ?? null],
    );
    return result.rows[0]?.rate;
  }

  public async findMostRecentCompletedScenarioRun(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<ScenarioRunRowData | undefined> {
    const sql = `
select
  id::text,
  (projected->>'monthlySavingsCapacityMinor')::text as "monthlySavingsCapacityMinor"
from public.scenario_runs
where workspace_id = $1::uuid
  and status = 'completed'
order by created_at desc, id desc
limit 1`;

    const result = await client.query<ScenarioRunRow>(sql, [workspaceId]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      monthlySavingsCapacityMinor: row.monthlySavingsCapacityMinor,
    };
  }

  public async createForecast(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    data: CreateForecastRecord,
  ): Promise<void> {
    const sql = `
insert into public.forecasts (
  id,
  workspace_id,
  job_id,
  status,
  confidence,
  method,
  horizon_days,
  assumptions,
  series,
  generated_at,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6,
  $7,
  $8::jsonb,
  $9::jsonb,
  $10::timestamptz,
  $11::uuid
)`;

    const values = [
      data.id,
      workspaceId,
      data.jobId,
      data.status,
      data.confidence,
      data.method,
      data.horizonDays,
      JSON.stringify(data.assumptions),
      JSON.stringify(data.series),
      data.generatedAt.toISOString(),
      subject,
    ];

    await client.query(sql, values);
  }
}
