import { Injectable } from '@nestjs/common';

import {
  PgTransaction,
  type TransactionClient,
} from '../platform/pg-transaction.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import type {
  BulkAction,
  BulkTransactionCommand,
} from './bulk-transaction-command.js';
import { PostgresTransactionAdapter } from './postgres-transaction.adapter.js';

const ROUTE = 'POST /v1/transactions/bulk';
const WRITER_ROLES = new Set(['owner', 'administrator', 'editor']);

type Failure = 'forbidden' | 'conflict' | 'not-found' | 'stale' | 'ineligible';
type Outcome =
  | { readonly kind: Failure }
  | { readonly kind: 'ok'; readonly body: unknown };

class BatchRollback extends Error {
  public constructor(public readonly kind: Failure) {
    super(kind);
  }
}

interface TargetRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly type: string;
  readonly importJobId: string | null;
  readonly amount: string;
  readonly linked: boolean;
}

@Injectable()
export class BulkTransactionService {
  public constructor(
    private readonly transaction: PgTransaction,
    private readonly ledger: PostgresTransactionAdapter,
    private readonly idempotency: PostgresIdempotencyAdapter,
  ) {}

  public async execute(
    subject: string,
    workspaceId: string,
    command: BulkTransactionCommand,
    key: string,
  ): Promise<Outcome> {
    const fingerprint = computeRequestFingerprint(command);
    try {
      return await this.transaction.run(
        subject,
        async (client): Promise<Outcome> => {
          const role = await this.ledger.readActiveRole(client, workspaceId);
          if (!role || !WRITER_ROLES.has(role)) return { kind: 'forbidden' };
          const existing = await this.idempotency.read(
            client,
            subject,
            ROUTE,
            key,
            workspaceId,
          );
          if (existing)
            return existing.requestFingerprint === fingerprint
              ? { kind: 'ok', body: existing.responseBody }
              : { kind: 'conflict' };

          const ids = command.targets.map(({ id }) => id);
          const visible = await client.query<{ accountId: string }>(
            `select account_id::text as "accountId" from public.transactions
           where workspace_id = $1::uuid and id = any($2::uuid[])`,
            [workspaceId, ids],
          );
          if (visible.rows.length !== ids.length) return { kind: 'not-found' };

          // Follow account-before-header order used by posting writers. Acquire
          // each lock set in a stable order regardless of target response order.
          const accounts = [
            ...new Set(visible.rows.map(({ accountId }) => accountId)),
          ].sort();
          let accountsEligible = true;
          for (const id of accounts) {
            const account = await this.ledger.lockAndReadAccount(
              client,
              workspaceId,
              id,
            );
            if (
              !account ||
              (command.action.type === 'confirm' && account.status === 'closed')
            )
              accountsEligible = false;
          }
          const locked = await client.query<TargetRow>(
            `select t.id::text, t.version, t.status, t.type,
                  t.import_job_id::text as "importJobId", t.amount_minor::text as amount,
                  (exists (select 1 from public.recurring_occurrences o where o.workspace_id = t.workspace_id and o.transaction_id = t.id)
                   or exists (select 1 from public.transfers tr where tr.workspace_id = t.workspace_id and tr.transaction_id = t.id)) as linked
             from public.transactions t
            where t.workspace_id = $1::uuid and t.id = any($2::uuid[])
            order by t.id for no key update of t`,
            [workspaceId, ids],
          );
          const versions = new Map(
            command.targets.map(({ id, expectedVersion }) => [
              id,
              expectedVersion,
            ]),
          );
          const lockedIds = new Set(locked.rows.map(({ id }) => id));
          const missing = ids.filter((id) => !lockedIds.has(id));
          // Update RLS excludes voided rows even from SELECT FOR UPDATE. They
          // are terminal, and the account locks serialize us against voiding.
          const voided = missing.length
            ? (
                await client.query<{ id: string; version: number }>(
                  `select id::text, version from public.transactions
                    where workspace_id = $1::uuid and id = any($2::uuid[]) and status = 'voided'`,
                  [workspaceId, missing],
                )
              ).rows
            : [];
          if (voided.length !== missing.length) return { kind: 'not-found' };
          if (
            [...locked.rows, ...voided].some(
              (row) => row.version !== versions.get(row.id),
            )
          )
            return { kind: 'stale' };
          if (
            voided.length > 0 ||
            !accountsEligible ||
            locked.rows.some((row) => !eligible(row, command.action))
          )
            return { kind: 'ineligible' };

          const mutation = await assignment(
            client,
            workspaceId,
            command.action,
          );
          if (!mutation) return { kind: 'ineligible' };
          const result = await client.query<{ id: string; version: number }>(
            `update public.transactions set ${mutation.sql}, version = version + 1, updated_at = now()
            where workspace_id = $1::uuid and id = any($2::uuid[]) returning id::text, version`,
            [workspaceId, ids, ...mutation.params],
          );
          if (result.rows.length !== ids.length)
            throw new BatchRollback('forbidden');
          const updated = new Map(result.rows.map((row) => [row.id, row]));
          const body = { updated: ids.map((id) => updated.get(id)) };
          if (
            !(await this.idempotency.write(
              client,
              subject,
              ROUTE,
              key,
              fingerprint,
              200,
              null,
              body,
              workspaceId,
            ))
          )
            throw new BatchRollback('conflict');
          return { kind: 'ok', body };
        },
      );
    } catch (error) {
      if (error instanceof BatchRollback) return { kind: error.kind };
      // Also reject a batch if a booking or reference is no longer eligible
      // when PostgreSQL enforces the underlying ledger constraints.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === '23503' || error.code === '23514')
      )
        return { kind: 'ineligible' };
      throw error;
    }
  }
}

function eligible(row: TargetRow, action: BulkAction): boolean {
  if (row.status === 'voided' || row.status === 'reconciled') return false;
  if (action.type === 'confirm')
    return row.status === 'confirmed' || !row.linked;
  if (action.type !== 'convertImported') return true;
  const amount = BigInt(row.amount);
  return (
    row.type === 'adjustment' &&
    row.importJobId !== null &&
    !row.linked &&
    (action.targetType === 'income' ? amount > 0n : amount < 0n)
  );
}

async function assignment(
  client: TransactionClient,
  workspaceId: string,
  action: BulkAction,
): Promise<{ sql: string; params: readonly unknown[] } | undefined> {
  switch (action.type) {
    case 'categorize':
    case 'setPayee': {
      const category = action.type === 'categorize';
      const id = category ? action.categoryId : action.payeeId;
      if (
        id !== null &&
        !(
          await client.query(
            `select id from public.${category ? 'categories' : 'payees'} where workspace_id = $1::uuid and id = $2::uuid`,
            [workspaceId, id],
          )
        ).rowCount
      )
        return undefined;
      return {
        sql: category ? 'category_id = $3::uuid' : 'payee_id = $3::uuid',
        params: [id],
      };
    }
    case 'tag': {
      const { rowCount } = await client.query(
        'select id from public.tags where workspace_id = $1::uuid and id = any($2::uuid[])',
        [workspaceId, action.tagIds],
      );
      if (rowCount !== action.tagIds.length) return undefined;
      return {
        sql: `tag_ids = coalesce(tag_ids, '{}'::uuid[]) || array(
          select id from unnest($3::uuid[]) with ordinality as incoming(id, position)
          where not (id = any(coalesce(tag_ids, '{}'::uuid[]))) order by position
        )`,
        params: [action.tagIds],
      };
    }
    case 'confirm':
      return { sql: "status = 'confirmed'", params: [] };
    case 'archive':
      return { sql: 'archived = true', params: [] };
    case 'unarchive':
      return { sql: 'archived = false', params: [] };
    case 'excludeFromReports':
      return { sql: 'excluded_from_reports = true', params: [] };
    case 'includeInReports':
      return { sql: 'excluded_from_reports = false', params: [] };
    case 'setExtraordinary':
      return { sql: 'extraordinary = $3', params: [action.extraordinary] };
    case 'convertImported':
      return { sql: 'type = $3', params: [action.targetType] };
  }
}
