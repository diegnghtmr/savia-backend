import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  Job,
  JobStatus,
  JobStore,
  JobType,
  JobWriter,
} from './job.port.js';

interface JobRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly progress_percent: number | null;
  readonly result_resource_id: string | null;
  readonly error: Record<string, unknown> | null;
  readonly created_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return value;
  }
  return '';
}

export class PostgresJobsAdapter implements JobStore, JobWriter {
  public async createTerminalJob(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    type: JobType,
    status: Extract<JobStatus, 'completed' | 'failed'>,
    resultResourceId: string | null,
    error: Record<string, unknown> | null,
  ): Promise<Job> {
    const result = await client.query<JobRow>(
      `insert into public.jobs (workspace_id,type,status,progress_percent,result_resource_id,error,created_by,started_at,completed_at)
       values ($1::uuid,$2,$3,$4,$5::uuid,$6::jsonb,$7::uuid,now(),now())
       returning id::text,type,status,progress_percent,result_resource_id::text as result_resource_id,error,created_at,started_at,completed_at`,
      [
        workspaceId,
        type,
        status,
        status === 'completed' ? 100 : null,
        resultResourceId,
        error ? JSON.stringify(error) : null,
        subject,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Terminal job was not created.');
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      progressPercent: row.progress_percent,
      resultResourceId: row.result_resource_id,
      error: row.error,
      createdAt: toIso(row.created_at),
      startedAt: toIso(row.started_at),
      completedAt: toIso(row.completed_at),
    };
  }
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const sql = `select public.workspace_actor_active_role($1::uuid) as role`;
    const result = await client.query<{ role: string | null }>(sql, [
      workspaceId,
    ]);
    return result.rows[0]?.role ?? undefined;
  }

  public async findJobById(
    client: TransactionClient,
    workspaceId: string,
    jobId: string,
  ): Promise<Job | undefined> {
    const sql = `
      select id::text,
             type,
             status,
             progress_percent,
             result_resource_id::text as result_resource_id,
             error,
             created_at,
             started_at,
             completed_at
        from public.jobs
       where workspace_id = $1::uuid
         and id = $2::uuid
       limit 1
    `;

    const result = await client.query<JobRow>(sql, [workspaceId, jobId]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      progressPercent:
        row.progress_percent !== null ? Number(row.progress_percent) : null,
      resultResourceId: row.result_resource_id ?? null,
      error: row.error ?? null,
      createdAt: toIso(row.created_at),
      startedAt: row.started_at ? toIso(row.started_at) : null,
      completedAt: row.completed_at ? toIso(row.completed_at) : null,
    };
  }
}
