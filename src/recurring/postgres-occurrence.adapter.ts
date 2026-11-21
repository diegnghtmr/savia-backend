import type { TransactionClient } from '../platform/pg-transaction.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type {
  DueOccurrence,
  DueRule,
  MaterializedOccurrence,
  OccurrenceStore,
} from './recurring-materializer.js';

interface DueRuleRow extends DueRule, Record<string, unknown> {}

export class PostgresOccurrenceAdapter implements OccurrenceStore {
  public async findDue(
    client: TransactionClient,
    asOf: string,
  ): Promise<readonly DueOccurrence[]> {
    const { rows } = await client.query<
      Omit<DueOccurrence, 'asOf'> & Record<string, unknown>
    >('select * from public.find_due_recurring_occurrences($1::timestamptz)', [
      asOf,
    ]);
    return rows.map((row) => ({ ...row, asOf }));
  }

  public async hasJob(
    client: TransactionClient,
    due: DueOccurrence,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `select 1 from public.jobs where workspace_id = $1::uuid and type = $2
        and payload->>'ruleId' = $3 and payload->>'scheduledAt' = $4`,
      [
        due.workspaceId,
        JOB_WRITER_TYPES.RECURRING_MATERIALIZATION,
        due.ruleId,
        due.scheduledAt,
      ],
    );
    return rows.length > 0;
  }

  public async lockDue(
    client: TransactionClient,
    { workspaceId, ruleId, subject, scheduledAt, asOf }: DueOccurrence,
  ): Promise<DueRule | undefined> {
    const result = await client.query<DueRuleRow>(
      `select frequency, rrule, behavior, template,
              starts_at as "startsAt", ends_at as "endsAt",
              anchor_day_of_month as "anchorDayOfMonth"
         from public.recurring_rules
        where workspace_id = $1::uuid and id = $2::uuid
          and created_by = $3::uuid
          and created_by = nullif(current_setting('app.subject_id', true), '')::uuid
          and public.workspace_actor_active_role(workspace_id) in ('owner', 'administrator', 'editor')
          and active and next_occurrence_at = $4::timestamptz
          and next_occurrence_at <= $5::timestamptz
          and (ends_at is null or next_occurrence_at <= ends_at)
        for update`,
      [workspaceId, ruleId, subject, scheduledAt, asOf],
    );
    const rule = result.rows[0];
    if (!rule) return undefined;

    // Recheck after locking the rule and hold the creator's write access through COMMIT.
    const membership = await client.query<{ allowed: boolean }>(
      'select public.lock_recurring_creator_membership($1::uuid) as allowed',
      [workspaceId],
    );
    return membership.rows[0]?.allowed ? rule : undefined;
  }

  public async record(
    client: TransactionClient,
    { workspaceId, ruleId, scheduledAt }: DueOccurrence,
    { id, behavior, transactionId, nextOccurrenceAt }: MaterializedOccurrence,
  ): Promise<void> {
    await client.query(
      `insert into public.recurring_occurrences
         (id, workspace_id, rule_id, scheduled_at, behavior, transaction_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6::uuid)`,
      [id, workspaceId, ruleId, scheduledAt, behavior, transactionId],
    );
    // Inactive rules retain their last date for the non-null RecurringRule projection.
    const result = await client.query(
      `update public.recurring_rules
          set next_occurrence_at = coalesce($3::timestamptz, next_occurrence_at),
              active = $3::timestamptz is not null
        where workspace_id = $1::uuid and id = $2::uuid`,
      [workspaceId, ruleId, nextOccurrenceAt],
    );
    if (result.rowCount !== 1)
      throw new Error('Recurring occurrence cursor was not advanced.');
  }
}
