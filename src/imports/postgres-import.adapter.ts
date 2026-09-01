import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  ImportFormat,
  ImportJob,
  ImportStore,
  ParsedImportRow,
} from './import.port.js';
import { normalizeImportDescription } from './import-parsers.js';
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
  source_columns: string[] | null;
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
    sourceColumns: row.source_columns ?? [],
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
    sourceColumns: readonly string[],
    counts: { total: number; valid: number; duplicate: number; errors: number },
    error: Record<string, unknown> | null,
  ): Promise<ImportJob> {
    const job = await client.query<JobRow>(
      `insert into public.import_jobs (id,workspace_id,file_name,status,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,error,created_by,source_columns) values ($1::uuid,$2::uuid,$3,'awaiting_mapping',$4,$5,$6,$7,$8,$9::jsonb,$10::uuid,$11::text[]) returning id::text,status,file_name,account_id,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,created_at,source_columns`,
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
        sourceColumns,
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
      'select id::text,status,file_name,account_id,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,created_at,source_columns from public.import_jobs where workspace_id=$1::uuid and id=$2::uuid',
      [workspaceId, id],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
  public async lockAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<{ status: string; currency: string } | undefined> {
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountId.toLowerCase()],
    );
    const result = await client.query<{ status: string; currency: string }>(
      'select status,currency from public.accounts where workspace_id=$1::uuid and id=$2::uuid',
      [workspaceId, accountId],
    );
    return result.rows[0];
  }
  public async findRows(
    client: TransactionClient,
    workspaceId: string,
    importJobId: string,
  ): Promise<readonly import('./import.port.js').ImportCommitRow[]> {
    const result = await client.query<
      import('./import.port.js').ImportCommitRow & Record<string, unknown>
    >(
      'select row_number as "rowNumber",raw_values as "rawValues",parsed_date as "parsedDate",parsed_amount_minor as "parsedAmountMinor",parsed_description as "parsedDescription",classification from public.import_job_rows where workspace_id=$1::uuid and import_job_id=$2::uuid order by row_number',
      [workspaceId, importJobId],
    );
    return result.rows;
  }
  public async complete(
    client: TransactionClient,
    workspaceId: string,
    importJobId: string,
    accountId: string,
    status: 'completed' | 'rolled_back',
  ): Promise<ImportJob | undefined> {
    const result = await client.query<JobRow>(
      "update public.import_jobs set status=$3,account_id=$4::uuid,completed_at=now() where workspace_id=$1::uuid and id=$2::uuid and status in ('awaiting_mapping','completed') returning id::text,status,file_name,account_id,detected_format,total_rows,valid_rows,duplicate_rows,error_rows,created_at,source_columns",
      [workspaceId, importJobId, status, accountId],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
  public async findExisting(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    date: string,
    amountMinor: string,
    description: string,
  ): Promise<boolean> {
    const result = await client.query<{ description: string | null }>(
      'select description from public.transactions where workspace_id=$1::uuid and account_id=$2::uuid and occurred_at::date=$3::date and amount_minor=$4',
      [workspaceId, accountId, date, amountMinor],
    );
    return result.rows.some(
      (row) =>
        row.description !== null &&
        normalizeImportDescription(row.description) ===
          normalizeImportDescription(description),
    );
  }
  public async findImportedTransactions(
    client: TransactionClient,
    workspaceId: string,
    importJobId: string,
  ): Promise<readonly import('./import.port.js').ImportedTransaction[]> {
    const result = await client.query<
      import('./import.port.js').ImportedTransaction & Record<string, unknown>
    >(
      'select id::text,account_id::text as "accountId",status,version from public.transactions where workspace_id=$1::uuid and import_job_id=$2::uuid order by id',
      [workspaceId, importJobId],
    );
    return result.rows;
  }
}
