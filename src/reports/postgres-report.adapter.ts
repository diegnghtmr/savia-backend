import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateReportDefinitionRequest,
  ReportDefinition,
  ReportDimension,
  ReportItem,
  ReportListQuery,
  ReportMeasure,
  ReportStore,
  ReportVisualization,
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
}
