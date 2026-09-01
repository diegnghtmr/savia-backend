import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { PostgresAccountsAdapter } from '../accounts/postgres-accounts.adapter.js';
import type { AccountCursor } from '../accounts/accounts.port.js';
import { PostgresTransactionAdapter } from '../ledger/postgres-transaction.adapter.js';
import type { TransactionCursor } from '../ledger/ledger.port.js';
import type {
  ExportJob,
  ExportRows,
  ExportStore,
  CreateExportJobCommand,
} from './export.port.js';
export class ExportUnrepresentableError extends Error {}

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
  public async reserve(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    id: string,
    command: CreateExportJobCommand,
    path: string,
  ): Promise<ExportJob> {
    return this.insert(client, workspaceId, subject, id, command, path, null, null, null, 'queued');
  }
  public async complete(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    url: string,
    expiresAt: string,
  ): Promise<ExportJob> {
    const result = await client.query<Row>(
      `update public.export_jobs set status='completed', download_url=$3, expires_at=$4::timestamptz, completed_at=now() where workspace_id=$1::uuid and id=$2::uuid and status in ('queued','processing') returning id::text,status,format,created_at,download_url,expires_at`,
      [workspaceId, id, url, expiresAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Reserved export job could not be completed.');
    return map(row);
  }
  public async fail(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    error: Record<string, unknown>,
  ): Promise<ExportJob> {
    const result = await client.query<Row>(
      `update public.export_jobs set status='failed', object_path=null, download_url=null, expires_at=null, error=$3::jsonb, completed_at=now() where workspace_id=$1::uuid and id=$2::uuid and status in ('queued','processing') returning id::text,status,format,created_at,download_url,expires_at`,
      [workspaceId, id, JSON.stringify(error)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Reserved export job could not be failed.');
    return map(row);
  }
  public async readRows(
    client: TransactionClient,
    workspaceId: string,
    command: CreateExportJobCommand,
  ): Promise<ExportRows> {
    const accounts: Record<string, unknown>[] = [];
    if (command.resource !== 'transactions') {
      let cursor: AccountCursor | undefined;
      for (;;) {
        const page = await this.accounts.listAccounts(client, workspaceId, cursor, 10000, undefined);
        for (const item of page) {
          let balance;
          try {
            balance = await this.accounts.readAccountBalance(client, workspaceId, item.account.id);
          } catch (error) {
            throw new ExportUnrepresentableError(error instanceof Error ? error.message : 'Account balance cannot be represented.');
          }
          if (!balance) throw new ExportUnrepresentableError(`Account ${item.account.id} disappeared during export.`);
          accounts.push({ ...item.account, balance });
        }
        if (page.length < 10000) break;
        const last = page[page.length - 1];
        cursor = { createdAt: last.cursorAt, id: last.account.id };
      }
    }
    const transactions: Record<string, unknown>[] = [];
    if (command.resource !== 'accounts') {
      let cursor: TransactionCursor | undefined;
      for (;;) {
        const page = await this.transactions.listTransactions(client, workspaceId, cursor, 10000, { from: command.from ?? undefined, to: command.to ?? undefined });
        transactions.push(...page.map((x) => x.transaction as unknown as Record<string, unknown>));
        if (page.length < 10000) break;
        const last = page[page.length - 1];
        cursor = { createdAt: last.cursorAt, id: last.transaction.id };
      }
    }
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
    status?: ExportJob['status'],
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
        status ?? (error ? 'failed' : 'completed'),
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
