import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  DueOccurrence,
  DueRule,
  MaterializedOccurrence,
  OccurrenceStore,
} from './recurring-materializer.js';

interface RuleRow extends DueRule, Record<string, unknown> {
  readonly creator: string;
  readonly version: number;
  readonly nextOccurrenceAt: Date;
  readonly active: boolean;
}

export class PostgresOccurrenceAdapter implements OccurrenceStore {
  public async findDue(
    client: TransactionClient,
    asOf: string,
  ): Promise<readonly DueOccurrence[]> {
    const { rows } = await client.query<
      Omit<DueOccurrence, 'asOf' | 'scheduleVersion'> & {
        scheduleVersion: number | null;
      }
    >(
      `select "workspaceId", subject, "ruleId", "scheduledAt", "scheduleVersion"
         from (
           select d.*, null::integer as "scheduleVersion", d."scheduledAt"::timestamptz as "effectiveAt"
             from public.find_due_recurring_occurrences($1::timestamptz) d
           union all
           select * from public.find_due_detached_recurring_occurrences($1::timestamptz)
         ) due
        order by "effectiveAt", "ruleId", "scheduledAt" limit 50`,
      [asOf],
    );
    return rows.map(({ scheduleVersion, ...row }) => ({
      ...row,
      asOf,
      ...(scheduleVersion !== null && { scheduleVersion }),
    }));
  }

  public async hasJob(
    client: TransactionClient,
    due: DueOccurrence,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `select 1 from public.jobs where workspace_id = $1::uuid and type = $2
        and payload->>'ruleId' = $3 and payload->>'scheduledAt' = $4
        and coalesce(payload->>'scheduleVersion', '') = $5`,
      [
        due.workspaceId,
        JOB_WRITER_TYPES.RECURRING_MATERIALIZATION,
        due.ruleId,
        due.scheduledAt,
        due.scheduleVersion?.toString() ?? '',
      ],
    );
    return rows.length > 0;
  }

  public async readRule(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    lock = false,
  ): Promise<RuleRow | undefined> {
    const { rows } = await client.query<RuleRow>(
      `select created_by::text as creator, frequency, rrule, behavior, template, version, active,
              next_occurrence_at as "nextOccurrenceAt",
              public.recurring_occurrence_slot_id(id, next_occurrence_at)::text as "occurrenceId",
              starts_at as "startsAt", ends_at as "endsAt", anchor_day_of_month as "anchorDayOfMonth"
         from public.recurring_rules where workspace_id = $1::uuid and id = $2::uuid
         ${lock ? 'for update' : ''}`,
      [workspaceId, ruleId],
    );
    return rows[0];
  }

  public async lockDue(
    client: TransactionClient,
    due: DueOccurrence,
  ): Promise<DueRule | undefined> {
    const { workspaceId, ruleId, subject, scheduledAt, asOf, scheduleVersion } =
      due;
    const rule = await this.readRule(client, workspaceId, ruleId, true);
    if (
      rule?.creator !== subject ||
      !(await this.lockCreatorMembership(client, workspaceId))
    )
      return undefined;

    // Re-read slot state after obtaining the same rule lock taken by the commands.
    const { rows } = await client.query<
      Pick<DueRule, 'occurrenceId' | 'template' | 'effectiveAt' | 'detached'>
    >(
      `select coalesce(o.id, public.recurring_occurrence_slot_id(r.id, $3::timestamptz))::text as "occurrenceId",
              t.template || coalesce(o.template, '{}'::jsonb) as template,
              regexp_replace(to_char(coalesce(o.effective_at, $3::timestamptz) at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '000Z$', 'Z') as "effectiveAt",
              o.effective_at is not null as detached
         from public.recurring_rules r
         cross join lateral public.recurring_template_at(r.template, r.series_changes, $3::timestamptz) t
         left join public.recurring_occurrences o on o.workspace_id = r.workspace_id
           and o.rule_id = r.id and o.scheduled_at = $3::timestamptz
        where r.workspace_id = $1::uuid and r.id = $2::uuid
          and r.created_by = nullif(current_setting('app.subject_id', true), '')::uuid
          and coalesce(o.effective_at, $3::timestamptz) <= $4::timestamptz
          and (o.id is null or not o.materialized)
          and ((o.effective_at is not null and ($5::integer is null or o.version = $5))
            or ($5::integer is null and r.active and r.next_occurrence_at = $3::timestamptz
                and (r.ends_at is null or r.next_occurrence_at <= r.ends_at)))`,
      [workspaceId, ruleId, scheduledAt, asOf, scheduleVersion ?? null],
    );
    return rows[0] && { ...rule, ...rows[0] };
  }

  public async lockCreatorMembership(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<boolean> {
    const membership = await client.query<{ allowed: boolean }>(
      'select public.lock_recurring_creator_membership($1::uuid) as allowed',
      [workspaceId],
    );
    return membership.rows[0]?.allowed === true;
  }

  public async record(
    client: TransactionClient,
    { workspaceId, ruleId, scheduledAt }: DueOccurrence,
    occurrence: MaterializedOccurrence,
  ): Promise<void> {
    const { id, behavior, transactionId, skipped, detached } = occurrence;
    const params = [
      id,
      workspaceId,
      ruleId,
      scheduledAt,
      behavior,
      transactionId,
      skipped ?? false,
    ];
    const updated = await client.query(
      `update public.recurring_occurrences o set materialized = true,
         transaction_id = $6::uuid, skipped_at = case when $7::boolean then now() end,
         template = t.template || o.template, version = o.version + t.revision + 1
       from public.recurring_rules r
       cross join lateral public.recurring_template_at(r.template, r.series_changes, $4::timestamptz) t
       where o.id = $1::uuid and o.workspace_id = $2::uuid and o.rule_id = $3::uuid
         and o.workspace_id = r.workspace_id and o.rule_id = r.id and o.behavior = $5
         and not o.materialized`,
      params,
    );
    if (updated.rowCount === 0) {
      const inserted = await client.query(
        `insert into public.recurring_occurrences
           (id, workspace_id, rule_id, scheduled_at, behavior, transaction_id, template, skipped_at, version)
         select $1::uuid, r.workspace_id, r.id, $4::timestamptz, $5, $6::uuid, t.template,
                case when $7::boolean then now() end, 2 + t.revision
           from public.recurring_rules r
           cross join lateral public.recurring_template_at(r.template, r.series_changes, $4::timestamptz) t
          where r.workspace_id = $2::uuid and r.id = $3::uuid`,
        params,
      );
      if (inserted.rowCount !== 1) throw new Error('Occurrence insert failed.');
    }
    if (!detached)
      await this.advance(
        client,
        workspaceId,
        ruleId,
        occurrence.nextOccurrenceAt,
      );
  }

  public async advance(
    client: TransactionClient,
    workspaceId: string,
    ruleId: string,
    next: string | null,
  ): Promise<void> {
    // Inactive rules retain their last date for the non-null RecurringRule projection.
    const result = await client.query(
      `update public.recurring_rules
          set next_occurrence_at = coalesce($3::timestamptz, next_occurrence_at),
              active = $3::timestamptz is not null
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ruleId, next],
    );
    if (result.rowCount !== 1)
      throw new Error('Recurring occurrence cursor was not advanced.');
  }
}
