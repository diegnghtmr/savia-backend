import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { PostgresAccountsAdapter } from '../accounts/postgres-accounts.adapter.js';
import { PostgresTransactionAdapter } from '../ledger/postgres-transaction.adapter.js';
import type {
  ExportJob,
  ExportRows,
  ExportStore,
  CreateExportJobCommand,
} from './export.port.js';

interface Row extends Record<string, unknown> {
  id: string;
  status: ExportJob['status'];
  format: ExportJob['format'];
  created_at: Date | string;
  download_url: string | null;
  expires_at: Date | string | null;
}
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
function map(row: Row): ExportJob {
  return {
    id: row.id,
    status: row.status,
    format: row.format,
    downloadUrl: row.download_url,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at) as string,
  };
}

export class PostgresExportAdapter implements ExportStore {
  public constructor(
    private readonly accounts = new PostgresAccountsAdapter(),
    private readonly transactions = new PostgresTransactionAdapter(),
  ) {}
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
  public createId(): string {
    return randomUUID();
  }
  public async readRows(
    client: TransactionClient,
    workspaceId: string,
    command: CreateExportJobCommand,
  ): Promise<ExportRows> {
    const accounts =
      command.resource === 'transactions'
        ? []
        : (
            await this.accounts.listAccounts(
              client,
              workspaceId,
              undefined,
              10000,
              undefined,
            )
          ).map((x) => x.account as unknown as Record<string, unknown>);
    const transactions =
      command.resource === 'accounts'
        ? []
        : (
            await this.transactions.listTransactions(
              client,
              workspaceId,
              undefined,
              10000,
              { from: command.from ?? undefined, to: command.to ?? undefined },
            )
          ).map((x) => x.transaction as unknown as Record<string, unknown>);
    return { accounts, transactions };
  }
  public async insert(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: CreateExportJobCommand,
    path: string,
    url: string | null,
    expiresAt: string | null,
    error: Record<string, unknown> | null,
  ): Promise<ExportJob> {
    const result = await client.query<Row>(
      `insert into public.export_jobs (id, workspace_id, format, resource, resource_id, from_date, to_date, status, object_path, download_url, expires_at, error, created_by, completed_at) values ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::date,$7::date,$8,$9,$10,$11::timestamptz,$12::jsonb,$13::uuid,case when $8 = 'completed' or $8 = 'failed' then now() end) returning id::text,status,format,created_at,download_url,expires_at`,
      [
        id,
        workspaceId,
        command.format,
        command.resource,
        command.resourceId,
        command.from,
        command.to,
        error ? 'failed' : 'completed',
        error ? null : path,
        url,
        expiresAt,
        error ? JSON.stringify(error) : null,
        subject,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Created export job row could not be read.');
    return map(row);
  }
  public async find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<ExportJob | undefined> {
    const result = await client.query<Row>(
      'select id::text,status,format,created_at,download_url,expires_at from public.export_jobs where workspace_id=$1::uuid and id=$2::uuid limit 1',
      [workspaceId, id],
    );
    const row = result.rows[0];
    return row ? map(row) : undefined;
  }
}
