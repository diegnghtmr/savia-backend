import type { Cursor } from '../platform/cursor.js';
import type {
  CreateTransactionCommand,
  Money,
} from '../platform/ledger-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type { TemplateChanges } from './occurrence-edit-command.js';
import { PostgresOccurrenceAdapter } from './postgres-occurrence.adapter.js';

export const OCCURRENCE_STATUSES = [
  'scheduled',
  'reminder',
  'draft',
  'pending',
  'confirmed',
  'reconciled',
  'voided',
  'skipped',
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
export interface OccurrenceRow extends Record<string, unknown> {
  readonly id: string;
  readonly cursorAt: string;
  readonly originalScheduledAt: string;
  readonly scheduledAt: string;
  readonly detached: boolean;
  readonly status: OccurrenceStatus;
  readonly transactionId: string | null;
  readonly template: CreateTransactionCommand;
  readonly amount: Money;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly version: number;
  readonly bookingVersion: number | null;
}

export class PostgresOccurrenceActionsAdapter extends PostgresOccurrenceAdapter {
  public async readOccurrences(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    input: {
      limit: number;
      id?: string;
      cursor?: Cursor;
      status?: OccurrenceStatus;
    },
  ): Promise<OccurrenceRow[]> {
    const { rows } = await client.query<OccurrenceRow>(
      `with rule as (
        select * from public.recurring_rules where workspace_id = $1::uuid and id = $2::uuid
       ), occurrences as (
         select o.id, o.scheduled_at, o.effective_at, o.transaction_id,
                case when o.materialized then o.template else s.template || o.template end as template,
                o.version + coalesce(s.revision, 0) as version,
                case when not o.materialized then 'scheduled' when o.skipped_at is not null then 'skipped'
                     else coalesce(t.status, 'reminder') end as status,
                t.version as booking_version, t.amount_minor, t.currency, t.description, t.category_id
           from rule r join public.recurring_occurrences o on o.workspace_id = r.workspace_id and o.rule_id = r.id
           left join lateral public.recurring_template_at(r.template, r.series_changes, o.scheduled_at) s on not o.materialized
           left join public.transactions t on t.workspace_id = o.workspace_id and t.id = o.transaction_id
         union all
         select public.recurring_occurrence_slot_id(r.id, r.next_occurrence_at), r.next_occurrence_at,
                null, null, s.template, 1 + s.revision, 'scheduled', null, null, null, null, null
           from rule r
           cross join lateral public.recurring_template_at(r.template, r.series_changes, r.next_occurrence_at) s
          where r.active and (r.ends_at is null or r.next_occurrence_at <= r.ends_at)
            and not exists (select 1 from public.recurring_occurrences o where o.workspace_id = r.workspace_id
              and o.rule_id = r.id and o.scheduled_at = r.next_occurrence_at)
       )
       select id::text,
              regexp_replace(to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '000Z$', 'Z') as "originalScheduledAt",
              regexp_replace(to_char(coalesce(effective_at, scheduled_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '000Z$', 'Z') as "scheduledAt",
              effective_at is not null as detached, status, transaction_id::text as "transactionId", template,
              to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
              version + coalesce(booking_version, 0) as version, booking_version as "bookingVersion",
              case when transaction_id is null then template->'amount'
                   else jsonb_build_object('amountMinor', amount_minor::text, 'currency', currency) end as amount,
              case when transaction_id is null then template->>'description' else description end as description,
              case when transaction_id is null then template->>'categoryId' else category_id::text end as "categoryId"
         from occurrences
        where ($3::timestamptz is null or (scheduled_at, id) > ($3::timestamptz, $4::uuid))
          and ($5::text is null or status = $5) and ($6::uuid is null or id = $6)
        order by scheduled_at, id limit $7`,
      [
        workspaceId,
        ruleId,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.status ?? null,
        input.id ?? null,
        input.limit,
      ],
    );
    return rows;
  }

  public async hasEffectiveSlot(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    exceptId: string,
    at: string,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `select 1 from public.recurring_occurrences where workspace_id = $1::uuid and rule_id = $2::uuid
        and id <> $3::uuid and coalesce(effective_at, scheduled_at) = $4::timestamptz`,
      [workspaceId, ruleId, exceptId, at],
    );
    return rows.length !== 0;
  }

  public async saveSlotEdit(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    row: OccurrenceRow,
    changes: TemplateChanges,
    scheduledAt?: string,
  ): Promise<void> {
    const values = [
      workspaceId,
      ruleId,
      row.id,
      JSON.stringify(changes),
      scheduledAt ?? null,
    ];
    const updated = await client.query(
      `update public.recurring_occurrences
          set template = template || $4::jsonb, effective_at = coalesce($5::timestamptz, effective_at),
              version = version + 1
        where workspace_id = $1::uuid and rule_id = $2::uuid and id = $3::uuid`,
      values,
    );
    if (updated.rowCount !== 0) return;
    const inserted = await client.query(
      `insert into public.recurring_occurrences
         (id, workspace_id, rule_id, scheduled_at, behavior, template, effective_at, materialized)
       select $3::uuid, workspace_id, id, next_occurrence_at, behavior, $4::jsonb, $5::timestamptz, false
         from public.recurring_rules where workspace_id = $1::uuid and id = $2::uuid and active
           and public.recurring_occurrence_slot_id(id, next_occurrence_at) = $3::uuid`,
      values,
    );
    if (inserted.rowCount !== 1)
      throw new Error('Occurrence edit was not recorded.');
  }

  public async hasCategory(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    const { rows } = await client.query(
      'select 1 from public.categories where workspace_id = $1::uuid and id = $2::uuid',
      [workspaceId, id],
    );
    return rows.length !== 0;
  }

  public async editSeries(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    effectiveFrom: string,
    changes: TemplateChanges,
  ): Promise<number | undefined> {
    const { rows } = await client.query<{ version: number }>(
      `update public.recurring_rules set version = version + 1, series_changes = series_changes || $4::jsonb
        where workspace_id = $1::uuid and id = $2::uuid and $3::timestamptz >= clock_timestamp()
        returning version`,
      [
        workspaceId,
        ruleId,
        effectiveFrom,
        JSON.stringify([{ effectiveFrom, changes }]),
      ],
    );
    return rows[0]?.version;
  }

  public async settle(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    id: string,
    transactionId: string | null,
    skip: boolean,
  ): Promise<void> {
    const updated = await client.query(
      `update public.recurring_occurrences
          set transaction_id = $4::uuid, skipped_at = case when $5::boolean then now() end, version = version + 1
        where workspace_id = $1::uuid and rule_id = $2::uuid and id = $3::uuid and skipped_at is null`,
      [workspaceId, ruleId, id, transactionId, skip],
    );
    if (updated.rowCount !== 1) throw new Error('Occurrence was not settled.');
  }
}
