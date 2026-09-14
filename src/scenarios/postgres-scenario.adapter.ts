import { CURRENCY_RATE_SELECTION_SQL } from '../platform/currency-conversion.js';
import { DEBT_OUTSTANDING_BALANCE_EXPRESSION } from '../platform/debt-balance-query.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  AccountNativeBalanceRow,
  CreateScenarioRequest,
  DebtOutstandingBalanceRow,
  Scenario,
  ScenarioAssumption,
  ScenarioFigureSet,
  ScenarioItem,
  ScenarioListQuery,
  ScenarioRun,
  ScenarioRunResult,
  ScenarioStore,
  TransactionFlowRow,
} from './scenario.port.js';

interface ScenarioRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly assumptions: readonly ScenarioAssumption[];
  readonly lastRunId: string | null;
  readonly createdAt: string;
  readonly cursorAt?: string;
}

interface ScenarioRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly scenarioId: string;
  readonly status: string;
  readonly baseline: ScenarioFigureSet;
  readonly projected: ScenarioFigureSet;
  readonly difference: ScenarioFigureSet;
  readonly risks: readonly string[];
}

function mapScenario(row: ScenarioRow): Scenario {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    assumptions: row.assumptions,
    createdAt: row.createdAt,
    lastRunId: row.lastRunId ?? null,
  };
}

export class PostgresScenarioAdapter implements ScenarioStore {
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

  public async createScenario(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateScenarioRequest,
  ): Promise<Scenario> {
    const sql = `
insert into public.scenarios (
  workspace_id,
  name,
  description,
  assumptions,
  created_by
)
values ($1::uuid, $2, $3, $4::jsonb, $5::uuid)
returning
  id::text,
  name,
  description,
  assumptions,
  last_run_id::text as "lastRunId",
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`;

    const values = [
      workspaceId,
      command.name,
      command.description ?? null,
      JSON.stringify(command.assumptions),
      subject,
    ];

    const result = await client.query<ScenarioRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Created scenario could not be read.');
    }
    return mapScenario(row);
  }

  public async findScenario(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Scenario | undefined> {
    const sql = `
select
  id::text,
  name,
  description,
  assumptions,
  last_run_id::text as "lastRunId",
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
from public.scenarios
where workspace_id = $1::uuid and id = $2::uuid`;

    const result = await client.query<ScenarioRow>(sql, [workspaceId, id]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return mapScenario(row);
  }

  public async listScenarios(
    client: TransactionClient,
    query: ScenarioListQuery,
    limit: number,
  ): Promise<readonly ScenarioItem[]> {
    const sql = `
select
  id::text,
  name,
  description,
  assumptions,
  last_run_id::text as "lastRunId",
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
from public.scenarios
where workspace_id = $1::uuid
  and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
order by created_at asc, id asc
limit $4`;

    const values = [
      query.workspaceId,
      query.cursor?.createdAt ?? null,
      query.cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<ScenarioRow>(sql, values);
    return result.rows.map((row) => ({
      scenario: mapScenario(row),
      cursorAt: row.cursorAt ?? row.createdAt,
    }));
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

  public async readAccountNativeBalances(
    client: TransactionClient,
    workspaceId: string,
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
group by acct.id, acct.currency`;

    const result = await client.query<AccountNativeBalanceRow>(sql, [
      workspaceId,
    ]);
    return result.rows;
  }

  public async readDebtOutstandingBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly DebtOutstandingBalanceRow[]> {
    const sql = `
select
  d.id::text as id,
  d.currency,
  ${DEBT_OUTSTANDING_BALANCE_EXPRESSION}::text as "outstandingBalanceMinor"
from public.debts d
where d.workspace_id = $1::uuid
  and d.status <> 'archived'`;

    const result = await client.query<DebtOutstandingBalanceRow>(sql, [
      workspaceId,
    ]);
    return result.rows;
  }

  public async readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly TransactionFlowRow[]> {
    const sql = `
select
  t.id::text as id,
  t.type,
  t.amount_minor::text as "amountMinor",
  t.currency,
  t.occurred_at as "occurredAt",
  t.category_id::text as "categoryId",
  c.name as "categoryName"
from public.transactions t
left join public.categories c
  on c.workspace_id = t.workspace_id
 and c.id = t.category_id
where t.workspace_id = $1::uuid
  and t.status in ('confirmed', 'reconciled')
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

  public async createScenarioRun(
    client: TransactionClient,
    workspaceId: string,
    scenarioId: string,
    subject: string,
    run: ScenarioRunResult,
  ): Promise<ScenarioRun> {
    const sql = `
insert into public.scenario_runs (
  workspace_id,
  scenario_id,
  status,
  baseline,
  projected,
  difference,
  risks,
  created_by
)
values ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::uuid)
returning
  id::text,
  scenario_id::text as "scenarioId",
  status,
  baseline,
  projected,
  difference,
  risks`;

    const values = [
      workspaceId,
      scenarioId,
      run.status,
      JSON.stringify(run.baseline),
      JSON.stringify(run.projected),
      JSON.stringify(run.difference),
      JSON.stringify(run.risks),
      subject,
    ];

    const result = await client.query<ScenarioRunRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Created scenario run could not be read.');
    }
    return {
      id: row.id,
      scenarioId: row.scenarioId,
      status: row.status as 'completed' | 'failed',
      baseline: row.baseline,
      projected: row.projected,
      difference: row.difference,
      risks: row.risks ?? [],
    };
  }

  public async updateScenarioLastRunId(
    client: TransactionClient,
    workspaceId: string,
    scenarioId: string,
    lastRunId: string,
  ): Promise<void> {
    const sql = `
update public.scenarios
set last_run_id = $3::uuid
where workspace_id = $1::uuid and id = $2::uuid`;

    await client.query(sql, [workspaceId, scenarioId, lastRunId]);
  }
}
