import type { Cursor } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  CreateRecurringRuleCommand,
  RecurringRule,
  Subscription,
  SubscriptionStatus,
} from './recurring.port.js';
import {
  RecurringAccountNotFoundError,
  type RecurringRuleItem,
  type RecurringStore,
  type SubscriptionItem,
} from './recurring.service.js';
import { computeIncreasePercent } from './subscription-calculation.js';

interface RecurringRuleRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly frequency: RecurringRule['frequency'];
  readonly rrule: string | null;
  readonly behavior: RecurringRule['behavior'];
  readonly template: RecurringRule['template'];
  readonly active: boolean;
  readonly nextOccurrenceAt: Date | string;
  readonly cursorAt?: string;
}

interface SubscriptionRow extends Record<string, unknown> {
  readonly id: string;
  readonly payeeName: string;
  readonly currentAmountMinor: string | number | bigint;
  readonly currentCurrency: string;
  readonly previousAmountMinor: string | number | bigint | null;
  readonly previousCurrency: string | null;
  readonly frequency: string;
  readonly nextExpectedAt: Date | string | null;
  readonly status: Subscription['status'];
  readonly cursorAt?: string;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return value;
  }
  return '';
}

export class PostgresRecurringAdapter implements RecurringStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const sql = `select public.workspace_actor_active_role($1::uuid) as role`;
    const result = await client.query<{ role: string | null }>(sql, [
      workspaceId,
    ]);
    return result.rows[0]?.role ?? undefined;
  }

  public async categoryBelongsToWorkspace(
    client: TransactionClient,
    workspaceId: string,
    categoryId: string,
  ): Promise<boolean> {
    const sql = `
      select 1
        from public.categories
       where workspace_id = $1::uuid
         and id = $2::uuid
       limit 1
    `;
    const result = await client.query(sql, [workspaceId, categoryId]);
    return (result.rowCount ?? 0) > 0;
  }

  public async payeeBelongsToWorkspace(
    client: TransactionClient,
    workspaceId: string,
    payeeId: string,
  ): Promise<boolean> {
    const sql = `
      select 1
        from public.payees
       where workspace_id = $1::uuid
         and id = $2::uuid
       limit 1
    `;
    const result = await client.query(sql, [workspaceId, payeeId]);
    return (result.rowCount ?? 0) > 0;
  }

  public async tagsBelongToWorkspace(
    client: TransactionClient,
    workspaceId: string,
    tagIds: readonly string[],
  ): Promise<boolean> {
    if (tagIds.length === 0) return true;
    const sql = `
      select count(*)::int as count
        from public.tags
       where workspace_id = $1::uuid
         and id = any($2::uuid[])
    `;
    const result = await client.query<{ count: number }>(sql, [
      workspaceId,
      tagIds,
    ]);
    return (result.rows[0]?.count ?? 0) === tagIds.length;
  }

  public async createRecurringRule(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateRecurringRuleCommand,
  ): Promise<RecurringRule> {
    const sql = `
      insert into public.recurring_rules (
        workspace_id,
        name,
        frequency,
        rrule,
        behavior,
        account_id,
        template,
        active,
        starts_at,
        ends_at,
        next_occurrence_at,
        anchor_day_of_month,
        created_by
      ) values (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6::uuid,
        $7::jsonb,
        true,
        $8::timestamptz,
        $9::timestamptz,
        $10::timestamptz,
        $11,
        $12::uuid
      )
      returning
        id::text,
        name,
        frequency,
        rrule,
        behavior,
        template,
        active,
        next_occurrence_at as "nextOccurrenceAt"
    `;

    const values = [
      workspaceId,
      command.name,
      command.frequency,
      command.rrule,
      command.behavior,
      command.template.accountId,
      JSON.stringify(command.template),
      command.startsAt,
      command.endsAt,
      command.nextOccurrenceAt,
      command.anchorDayOfMonth,
      subject,
    ];

    try {
      const result = await client.query<RecurringRuleRow>(sql, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to insert recurring rule.');
      }

      return {
        id: row.id,
        name: row.name,
        frequency: row.frequency,
        rrule: row.rrule ?? null,
        behavior: row.behavior,
        template: row.template,
        active: row.active,
        nextOccurrenceAt: toIso(row.nextOccurrenceAt),
      };
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const pgError = error as { code: string; constraint?: string };
        // RULING 53 / RULING 48: Composite FK violation on account_id
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'recurring_rules_account_workspace_fkey'
        ) {
          throw new RecurringAccountNotFoundError();
        }
      }
      throw error;
    }
  }

  public async listRecurringRules(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
  ): Promise<readonly RecurringRuleItem[]> {
    const sql = `
      select id::text,
             name,
             frequency,
             rrule,
             behavior,
             template,
             active,
             next_occurrence_at as "nextOccurrenceAt",
             to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
        from public.recurring_rules
       where workspace_id = $1::uuid
         and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
       order by created_at, id
       limit $4
    `;

    const values = [
      workspaceId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<RecurringRuleRow>(sql, values);

    return result.rows.map((row) => ({
      rule: {
        id: row.id,
        name: row.name,
        frequency: row.frequency,
        rrule: row.rrule ?? null,
        behavior: row.behavior,
        template: row.template,
        active: row.active,
        nextOccurrenceAt: toIso(row.nextOccurrenceAt),
      },
      cursorAt: row.cursorAt ?? '',
    }));
  }

  public async listSubscriptions(
    client: TransactionClient,
    workspaceId: string,
    cursor: Cursor | undefined,
    limit: number,
    status?: SubscriptionStatus,
  ): Promise<readonly SubscriptionItem[]> {
    const sql = `
      select id::text,
             payee_name as "payeeName",
             current_amount_minor::text as "currentAmountMinor",
             current_currency as "currentCurrency",
             previous_amount_minor::text as "previousAmountMinor",
             previous_currency as "previousCurrency",
             frequency,
             next_expected_at as "nextExpectedAt",
             status,
             to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
        from public.subscriptions
       where workspace_id = $1::uuid
         and ($2::text is null or status = $2)
         and ($3::timestamptz is null or (created_at, id) > ($3::timestamptz, $4::uuid))
       order by created_at, id
       limit $5
    `;

    const values = [
      workspaceId,
      status ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit,
    ];

    const result = await client.query<SubscriptionRow>(sql, values);

    return result.rows.map((row) => {
      const currentAmount = {
        amountMinor: String(row.currentAmountMinor),
        currency: row.currentCurrency,
      };
      const previousAmount =
        row.previousAmountMinor !== null && row.previousCurrency !== null
          ? {
              amountMinor: String(row.previousAmountMinor),
              currency: row.previousCurrency,
            }
          : undefined;

      const increasePercent = computeIncreasePercent(
        currentAmount,
        previousAmount,
      );

      return {
        subscription: {
          id: row.id,
          payeeName: row.payeeName,
          currentAmount,
          ...(previousAmount !== undefined ? { previousAmount } : {}),
          increasePercent,
          frequency: row.frequency,
          nextExpectedAt: row.nextExpectedAt ? toIso(row.nextExpectedAt) : null,
          status: row.status,
        },
        cursorAt: row.cursorAt ?? '',
      };
    });
  }
}
