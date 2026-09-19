import type { TransactionClient } from '../platform/pg-transaction.js';
import { multiplyMinorByRate } from '../platform/currency-conversion.js';
import type {
  CreateReportRunRecord,
  CreateReportDefinitionRequest,
  ReportDefinition,
  ReportDimension,
  ReportItem,
  ReportListQuery,
  ReportMeasure,
  ReportStore,
  ReportVisualization,
  ReportRun,
  ReportRunFormat,
  ReportRunStatus,
} from './report.port.js';
import type { ReportSourceRow } from './report.port.js';
import {
  getReportSourceRowCap,
  ReportMissingRateError,
  ReportRowCapExceededError,
} from './report.port.js';

interface ReportDefinitionRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly visualization: string;
  readonly filters: Record<string, unknown>;
  readonly version: number;
  readonly createdAt: string;
  readonly cursorAt?: string;
}

function mapReportDefinition(row: ReportDefinitionRow): ReportDefinition {
  return {
    id: row.id,
    name: row.name,
    dimensions: row.dimensions,
    measures: row.measures,
    visualization: row.visualization as ReportVisualization,
    filters: row.filters ?? {},
    version: row.version,
  };
}

export class PostgresReportAdapter implements ReportStore {
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

  public async createReportDefinition(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateReportDefinitionRequest,
  ): Promise<ReportDefinition> {
    const sql = `
insert into public.report_definitions (
  workspace_id,
  name,
  dimensions,
  measures,
  visualization,
  filters,
  created_by
)
values ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7::uuid)
returning
  id::text,
  name,
  dimensions,
  measures,
  visualization,
  filters,
  version,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`;

    const values = [
      workspaceId,
      command.name,
      JSON.stringify(command.dimensions),
      JSON.stringify(command.measures),
      command.visualization,
      JSON.stringify(command.filters ?? {}),
      subject,
    ];

    const result = await client.query<ReportDefinitionRow>(sql, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Created report definition could not be read.');
    }
    return mapReportDefinition(row);
  }

  public async listReportDefinitions(
    client: TransactionClient,
    query: ReportListQuery,
    limit: number,
  ): Promise<readonly ReportItem[]> {
    const sql = `
select
  id::text,
  name,
  dimensions,
  measures,
  visualization,
  filters,
  version,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
from public.report_definitions
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

    const result = await client.query<ReportDefinitionRow>(sql, values);
    return result.rows.map((row) => ({
      reportDefinition: mapReportDefinition(row),
      cursorAt: row.cursorAt ?? row.createdAt,
    }));
  }

  public async readReportDefinition(
    client: TransactionClient,
    workspaceId: string,
    definitionId: string,
  ): Promise<ReportDefinition | undefined> {
    const result = await client.query<ReportDefinitionRow>(
      `select id::text, name, dimensions, measures, visualization, filters, version
       from public.report_definitions where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, definitionId],
    );
    return result.rows[0] ? mapReportDefinition(result.rows[0]) : undefined;
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

  public async readReportSourceRows(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    typeFilter?: string,
    callerTypeFilter?: string,
  ): Promise<readonly ReportSourceRow[]> {
    const types =
      typeFilter && callerTypeFilter && typeFilter !== callerTypeFilter
        ? []
        : (typeFilter ?? callerTypeFilter);
    const sql = `
select t.id::text as "transactionId", t.occurred_at as "occurredAt", t.type,
       t.status, t.amount_minor::text as "amountMinor", t.currency,
       rates.rate,
       t.account_id::text as "accountId", coalesce(a.type, '') as "accountType",
       t.category_id::text as "categoryId", coalesce(tags.names, '{}') as tags,
       p.name as payee, t.created_by::text as "memberId",
       w.base_currency as "baseCurrency"
from public.transactions t
join public.workspaces w on w.id = t.workspace_id
join public.accounts a on a.workspace_id = t.workspace_id and a.id = t.account_id
left join public.payees p on p.workspace_id = t.workspace_id and p.id = t.payee_id
left join lateral (
  select array_agg(tag.name order by tag.name) as names
  from public.tags tag where tag.workspace_id = t.workspace_id and tag.id = any(coalesce(t.tag_ids, '{}'))
) tags on true
left join lateral (
  select rate::text as rate from public.exchange_rates
   where workspace_id = t.workspace_id and base_currency = t.currency and quote_currency = w.base_currency
   order by (effective_at <= now()) desc, case when effective_at <= now() then effective_at end desc, effective_at asc, id desc
   limit 1
) rates on t.currency <> w.base_currency
where t.workspace_id = $1::uuid
  and t.status in ('confirmed', 'reconciled')
  and exists (
    select 1 from public.ledger_postings p1
    where p1.workspace_id = t.workspace_id and p1.transaction_id = t.id
      and p1.status in ('confirmed', 'reconciled') and p1.transfer_id is null
  )
  and not exists (
    select 1 from public.ledger_postings p2
    where p2.workspace_id = t.workspace_id and p2.transaction_id = t.id
      and p2.status not in ('confirmed', 'reconciled')
  )
  and (t.occurred_at at time zone 'utc')::date between $2::date and $3::date
  and ($4::text is null or t.type = $4::text)
order by t.occurred_at asc, t.id asc
limit $5`;
    const cap = getReportSourceRowCap();
    const limitValue = Number.isFinite(cap) ? cap + 1 : null;
    const result = await client.query<Record<string, unknown>>(sql, [
      workspaceId,
      from,
      to,
      types || null,
      limitValue,
    ]);
    if (Number.isFinite(cap) && result.rows.length > cap) {
      throw new ReportRowCapExceededError(cap);
    }
    for (const row of result.rows) {
      if (row.currency !== row.baseCurrency && row.rate === null) {
        throw new ReportMissingRateError(
          String(row.currency),
          String(row.baseCurrency),
        );
      }
    }
    return result.rows.map((row) => ({
      transactionId: String(row.transactionId),
      occurredAt: new Date(String(row.occurredAt)),
      type: row.type as ReportSourceRow['type'],
      status: String(row.status),
      amountMinor: BigInt(String(row.amountMinor)),
      currency: String(row.currency),
      convertedMinor: BigInt(
        row.currency === row.baseCurrency
          ? String(row.amountMinor)
          : multiplyMinorByRate(String(row.amountMinor), String(row.rate)),
      ),
      accountId: String(row.accountId),
      accountType: String(row.accountType),
      categoryId: row.categoryId === null ? null : String(row.categoryId),
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      payee: row.payee === null ? null : String(row.payee),
      memberId: String(row.memberId),
    }));
  }

  public async readBudgetedMinorByBucket(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    dimensions: readonly ReportDimension[],
  ): Promise<ReadonlyMap<string, bigint>> {
    if (!dimensions.includes('month') || !dimensions.includes('category'))
      return new Map();
    const result = await client.query<{
      month: string;
      categoryId: string;
      plannedMinor: string;
    }>(
      `select to_char(b.period_start, 'YYYY-MM-01') as month, ba.category_id::text as "categoryId",
              ba.planned_minor::text as "plannedMinor"
         from public.budgets b join public.budget_allocations ba on ba.workspace_id = b.workspace_id and ba.budget_id = b.id
        where b.workspace_id = $1::uuid and b.period_start <= $3::date and b.period_end >= $2::date`,
      [workspaceId, from, to],
    );
    return new Map(
      result.rows.map((row) => [
        `${row.month}\x1f${row.categoryId}`,
        BigInt(row.plannedMinor),
      ]),
    );
  }

  public async insertReportRun(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    data: CreateReportRunRecord,
  ): Promise<ReportRun> {
    const result = await client.query<ReportRunRow>(
      `insert into public.report_runs (id, workspace_id, definition_id, preset, status, format, snapshot_id, object_path, download_url, expires_at, filters, created_by, completed_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4, 'completed', $5, $6::uuid, $7, $8, $9::timestamptz, $10::jsonb, $11::uuid, $12::timestamptz)
       returning id::text, definition_id::text as "definitionId", preset, status, format, snapshot_id::text as "snapshotId", download_url as "downloadUrl",
                 to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
                 to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`,
      [
        data.id,
        workspaceId,
        data.definitionId,
        data.preset,
        data.format,
        data.snapshotId,
        `${workspaceId}/${data.id}.${data.format}`,
        data.downloadUrl,
        data.expiresAt.toISOString(),
        JSON.stringify(data.filters),
        subject,
        data.completedAt.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Created report run could not be read.');
    return mapReportRun(row);
  }

  public async findReportRun(
    client: TransactionClient,
    workspaceId: string,
    reportRunId: string,
  ): Promise<ReportRun | undefined> {
    const result = await client.query<ReportRunRow>(
      `select id::text, definition_id::text as "definitionId", preset, status, format, snapshot_id::text as "snapshotId", download_url as "downloadUrl",
              to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
              to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
         from public.report_runs where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, reportRunId],
    );
    return result.rows[0] ? mapReportRun(result.rows[0]) : undefined;
  }
}

interface ReportRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly definitionId: string | null;
  readonly preset: string | null;
  readonly status: string;
  readonly format: string;
  readonly snapshotId: string | null;
  readonly downloadUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

function mapReportRun(row: ReportRunRow): ReportRun {
  return {
    id: row.id,
    definitionId: row.definitionId,
    preset: row.preset,
    status: row.status as ReportRunStatus,
    format: row.format as ReportRunFormat,
    snapshotId: row.snapshotId,
    downloadUrl: row.downloadUrl,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
