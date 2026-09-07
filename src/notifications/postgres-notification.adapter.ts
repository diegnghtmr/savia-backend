import type { Cursor } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  NotificationRow,
  NotificationStore,
} from './notification.port.js';

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

export class PostgresNotificationAdapter implements NotificationStore {
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
