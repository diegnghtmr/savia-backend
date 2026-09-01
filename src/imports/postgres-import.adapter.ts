import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  ImportFormat,
  ImportJob,
  ImportStore,
  ParsedImportRow,
} from './import.port.js';
function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
interface JobRow extends Record<string, unknown> {
  id: string;
  status: ImportJob['status'];
  file_name: string;
  account_id: string | null;
  detected_format: ImportFormat | null;
  total_rows: number | null;
  valid_rows: number | null;
  duplicate_rows: number | null;
  error_rows: number | null;
  created_at: Date | string;
}
function map(row: JobRow): ImportJob {
  return {
    id: row.id,
    status: row.status,
    fileName: row.file_name,
    accountId: row.account_id,
    detectedFormat: row.detected_format,
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    duplicateRows: row.duplicate_rows,
    errorRows: row.error_rows,
    createdAt: iso(row.created_at),
  };
}
export class PostgresImportAdapter implements ImportStore {
  public readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    return client
      .query<{
        role: string | null;
      }>('select public.workspace_actor_active_role($1::uuid) as role', [
        workspaceId,
      ])
      .then((r) => r.rows[0]?.role ?? undefined);
  }
  public createId(): string {
    return randomUUID();
  }
  public async createJob(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    fileName: string,
    detectedFormat: ImportFormat | null,
    rows: readonly ParsedImportRow[],
    counts: { total: number; valid: number; duplicate: number; errors: number },
    error: Record<string, unknown> | null,
  ): Promise<ImportJob> {
    const job = await client.query<JobRow>(
      `insert into public.import_jobs (id,workspace_id,file_name,status,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,error,created_by) values ($1::uuid,$2::uuid,$3,'awaiting_mapping',$4,$5,$6,$7,$8,$9::jsonb,$10::uuid) returning id::text,status,file_name,account_id,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,created_at`,
      [
        id,
        workspaceId,
        fileName,
        detectedFormat,
        counts.total,
        counts.valid,
        counts.duplicate,
        counts.errors,
        error ? JSON.stringify(error) : null,
        subject,
      ],
    );
    const row = job.rows[0];
    if (!row) throw new Error('Import job was not created.');
    if (rows.length) {
      const rowsPerBatch = 5_000;
      for (
        let batchStart = 0;
        batchStart < rows.length;
        batchStart += rowsPerBatch
      ) {
        const batch = rows.slice(batchStart, batchStart + rowsPerBatch);
        const values: unknown[] = [];
        const placeholders = batch
          .map((r, i) => {
            const base = i * 10;
            values.push(
              randomUUID(),
              workspaceId,
              id,
              r.rowNumber,
              JSON.stringify(r.rawValues),
              r.parsedDate,
              r.parsedAmountMinor,
              r.parsedDescription,
              r.classification,
              r.error ? JSON.stringify(r.error) : null,
            );
            return `($${base + 1}::uuid,$${base + 2}::uuid,$${base + 3}::uuid,$${base + 4},$${base + 5}::jsonb,$${base + 6}::date,$${base + 7},$${base + 8},$${base + 9},$${base + 10}::jsonb)`;
          })
          .join(',');
        await client.query(
          `insert into public.import_job_rows (id,workspace_id,import_job_id,row_number,raw_values,parsed_date,parsed_amount_minor,parsed_description,classification,error) values ${placeholders}`,
          values,
        );
      }
    }
    return map(row);
  }
  public async find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<ImportJob | undefined> {
    const result = await client.query<JobRow>(
      'select id::text,status,file_name,account_id,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,created_at from public.import_jobs where workspace_id=$1::uuid and id=$2::uuid',
      [workspaceId, id],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
}
