import type { JobExecutionContext } from '../platform/job-handler.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export interface BackupPayload {
  readonly backupId: string;
}

type Row = Record<string, unknown>;
export interface BackupReceipt extends Row {
  readonly id: string;
  readonly file_name: string;
  readonly storage_path: string;
}

export interface BackupSnapshot extends Record<string, unknown> {
  readonly snapshot_at: Date;
  readonly datasets: Readonly<Record<string, readonly Row[]>>;
  readonly receipts: readonly BackupReceipt[];
}

// A portable-data allowlist, not a database dump. Never read profiles, auth,
// credential/grant records, idempotency replies, agent text or queue payloads.
const TABLES = [
  'workspaces',
  'workspace_memberships',
  'accounts',
  'transactions',
  'ledger_postings',
  'transfers',
  'categories',
  'payees',
  'tags',
  'exchange_rates',
  'recurring_rules',
  'subscriptions',
  'reconciliations',
  'budgets',
  'budget_allocations',
  'funds',
  'fund_contributions',
  'debts',
  'debt_payments',
  'scenarios',
  'scenario_runs',
  'forecasts',
  'report_definitions',
  'report_runs',
  'import_jobs',
  'import_job_rows',
  'job_transitions',
] as const;

type Table = (typeof TABLES)[number];
const OMIT: Partial<Record<Table, string>> = {
  report_runs:
    "array['object_path','download_url','expires_at','error','job_id']",
  import_jobs: "array['error']",
  import_job_rows: "array['error','raw_values']",
  job_transitions: "array['error']",
};

function wireRow(table: Table): string {
  const row = `to_jsonb(t)${OMIT[table] ? ` - ${OMIT[table]}` : ''}`;
  // Preserve DECIMAL and bigint values across the PG → JavaScript JSON boundary.
  const exactId = table === 'job_transitions' ? " or k = 'id'" : '';
  const exact = `(k ~ '(_minor|_rate)$' or k = 'rate'${exactId})`;
  return `(select jsonb_object_agg(k, case when ${exact} and jsonb_typeof(v) = 'number'
                   then to_jsonb(v #>> '{}') else v end) from jsonb_each(${row}) as fields(k,v))`;
}

const DATASETS_SQL = TABLES.map((table) => {
  const scope = table === 'workspaces' ? 'id' : 'workspace_id';
  return `'${table}', coalesce((select jsonb_agg(${wireRow(table)} order by t.id)
                                  from public.${table} t
                                 where t.${scope} = b.workspace_id), '[]'::jsonb)`;
}).join(',\n');

const SNAPSHOT_SQL = `
  select statement_timestamp() as snapshot_at,
         jsonb_build_object(${DATASETS_SQL}) as datasets,
         coalesce((select jsonb_agg(to_jsonb(r) - array['error','job_id'] order by r.id)
                      from public.receipts r where r.workspace_id = b.workspace_id), '[]'::jsonb) as receipts
    from public.workspace_backups b
    join public.jobs j on (j.workspace_id, j.id, j.created_by) = (b.workspace_id, b.job_id, b.created_by)
   where b.id = $1::uuid and b.workspace_id = $2::uuid and j.id = $3::uuid
     and b.created_by = $4::uuid and j.type = 'workspace_backup' and j.status = 'processing'
     and j.attempt_count = $5`;

export async function readBackupSnapshot(
  client: TransactionClient,
  context: JobExecutionContext<BackupPayload>,
): Promise<BackupSnapshot | undefined> {
  // One SQL statement: every dataset, authorization check and receipt pointer
  // sees the same MVCC snapshot under the requesting actor's RLS.
  const { rows } = await client.query<BackupSnapshot>(SNAPSHOT_SQL, [
    context.payload.backupId,
    context.workspaceId,
    context.jobId,
    context.actorId,
    context.attemptCount,
  ]);
  return rows[0];
}
