import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateScenarioRequest,
  Scenario,
  ScenarioAssumption,
  ScenarioItem,
  ScenarioListQuery,
  ScenarioStore,
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
}
