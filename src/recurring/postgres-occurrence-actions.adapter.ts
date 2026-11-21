import type { Cursor } from '../platform/cursor.js';
import type {
  CreateTransactionCommand,
  Money,
} from '../platform/ledger-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { PostgresOccurrenceAdapter } from './postgres-occurrence.adapter.js';
import type { DueRule } from './recurring-materializer.js';

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
  readonly scheduledAt: Date;
  readonly status: OccurrenceStatus;
  readonly transactionId: string | null;
  readonly template: CreateTransactionCommand;
  readonly amount: Money;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly version: number;
  readonly bookingVersion: number | null;
}
interface RuleRow extends DueRule, Record<string, unknown> {
  readonly creator: string;
}

export class PostgresOccurrenceActionsAdapter extends PostgresOccurrenceAdapter {
  public async readRule(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    lock = false,
  ): Promise<RuleRow | undefined> {
    const { rows } = await client.query<RuleRow>(
      `select created_by::text as creator, frequency, rrule, behavior, template,
              public.recurring_occurrence_slot_id(id, next_occurrence_at)::text as "occurrenceId",
              starts_at as "startsAt", ends_at as "endsAt", anchor_day_of_month as "anchorDayOfMonth"
         from public.recurring_rules where workspace_id = $1::uuid and id = $2::uuid
         ${lock ? 'for update' : ''}`,
      [workspaceId, ruleId],
    );
    return rows[0];
  }

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
      `with occurrences as (
         select o.id, o.scheduled_at, o.transaction_id, o.template, o.version,
                case when o.skipped_at is not null then 'skipped' else coalesce(t.status, 'reminder') end as status,
                t.version as booking_version, t.amount_minor, t.currency, t.description, t.category_id
           from public.recurring_occurrences o
           left join public.transactions t on t.workspace_id = o.workspace_id and t.id = o.transaction_id
          where o.workspace_id = $1::uuid and o.rule_id = $2::uuid
         union all
         select public.recurring_occurrence_slot_id(r.id, r.next_occurrence_at), r.next_occurrence_at,
                null, r.template, 1, 'scheduled', null, null, null, null, null
           from public.recurring_rules r
          where r.workspace_id = $1::uuid and r.id = $2::uuid and r.active
            and (r.ends_at is null or r.next_occurrence_at <= r.ends_at)
       )
       select id::text, scheduled_at as "scheduledAt", status, transaction_id::text as "transactionId", template,
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
