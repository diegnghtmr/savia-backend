import { Logger } from '@nestjs/common';
import type { Cursor } from '../platform/cursor.js';
import type {
  BudgetThreshold,
  BudgetThresholdNotificationWriter,
  NotificationEvent,
  NotificationWriter,
} from '../platform/notification-writer.port.js';
import type {
  ActorWriteTransactionClient,
  TransactionClient,
} from '../platform/pg-transaction.js';
import type {
  NotificationRow,
  NotificationStore,
} from './notification.port.js';

const NOTIFICATION_INSERT_TIMEOUT_MS = 200;

interface NotificationSqlRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string | null;
  readonly read: boolean;
  readonly actionUrl: string | null;
  readonly createdAt: Date | string;
  readonly cursorAt: string;
}

export class PostgresNotificationAdapter
  implements
    NotificationStore,
    NotificationWriter,
    BudgetThresholdNotificationWriter
{
  private readonly logger = new Logger(PostgresNotificationAdapter.name);

  public async publish(
    client: ActorWriteTransactionClient,
    event: NotificationEvent,
  ): Promise<void> {
    await client.query('savepoint notification_publish');
    try {
      await client.query(
        `insert into public.notifications (workspace_id, subject_id, type, resource_id, title)
         values ($1::uuid, $2::uuid, $3, $4::uuid, $5)
         on conflict (workspace_id, subject_id, type, resource_id) do nothing`,
        [
          event.workspaceId,
          event.recipientId,
          event.type,
          event.resourceId,
          event.title,
        ],
        { statementTimeoutMs: NOTIFICATION_INSERT_TIMEOUT_MS },
      );
    } catch {
      // A statement rejection must not leave the caller's transaction aborted.
      await client.query('rollback to savepoint notification_publish');
      this.logger.warn('In-app notification insert failed.');
    }
    await client.query('release savepoint notification_publish');
  }

  public async publishBudgetThresholds(
    client: TransactionClient,
    workspaceId: string,
    budgetId: string,
    day: string,
    thresholds: readonly BudgetThreshold[],
  ): Promise<void> {
    await client.query(
      'select public.publish_budget_thresholds($1, $2, $3, $4)',
      [workspaceId, budgetId, day, thresholds],
    );
  }

  public async listNotifications(
    client: TransactionClient,
    subject: string,
    unreadOnly: boolean,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly NotificationRow[]> {
    const result = await client.query<NotificationSqlRow>(
      cursor === undefined
        ? `select id::text,
                  type,
                  title,
                  body,
                  read,
                  action_url as "actionUrl",
                  created_at as "createdAt",
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
             from public.notifications
            where subject_id = $1::uuid
              and ($2::boolean = false or read = false)
            order by created_at asc, id asc
            limit $3`
        : `select id::text,
                  type,
                  title,
                  body,
                  read,
                  action_url as "actionUrl",
                  created_at as "createdAt",
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
             from public.notifications
            where subject_id = $1::uuid
              and ($2::boolean = false or read = false)
              and (created_at, id) > ($3::timestamptz, $4::uuid)
            order by created_at asc, id asc
            limit $5`,
      cursor === undefined
        ? [subject, unreadOnly, limit]
        : [subject, unreadOnly, cursor.createdAt, cursor.id, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      read: row.read,
      actionUrl: row.actionUrl,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      cursorAt: row.cursorAt,
    }));
  }

  public async markNotificationRead(
    client: TransactionClient,
    subject: string,
    notificationId: string,
    now: Date,
  ): Promise<boolean> {
    interface IdRow extends Record<string, unknown> {
      readonly id: string;
    }
    const result = await client.query<IdRow>(
      `update public.notifications
          set read = true,
              read_at = coalesce(read_at, $3)
        where id = $1::uuid and subject_id = $2::uuid
       returning id`,
      [notificationId, subject, now],
    );
    return result.rows.length > 0;
  }
}
