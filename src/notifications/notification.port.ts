import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const NOTIFICATION_PORT = Symbol('NotificationPort');

export const NOTIFICATION_OUTCOMES = {
  OK: 'ok',
  NO_CONTENT: 'no_content',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  REPLAYED: 'replayed',
} as const;

export type NotificationOutcomeKind =
  (typeof NOTIFICATION_OUTCOMES)[keyof typeof NOTIFICATION_OUTCOMES];

export interface NotificationDto {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string | null;
  readonly read: boolean;
  readonly actionUrl: string | null;
  readonly createdAt: string;
}

export interface NotificationPage {
  readonly items: readonly NotificationDto[];
  readonly pageInfo: PageInfo;
}

export interface NotificationListQuery {
  readonly subject: string;
  readonly limit: number;
  readonly unreadOnly: boolean;
  readonly cursor?: Cursor;
}

export interface NotificationListOutcome {
  readonly kind: typeof NOTIFICATION_OUTCOMES.OK;
  readonly page: NotificationPage;
}

export interface NotificationMarkReadNoContentOutcome {
  readonly kind: typeof NOTIFICATION_OUTCOMES.NO_CONTENT;
}

export interface NotificationMarkReadReplayedOutcome {
  readonly kind: typeof NOTIFICATION_OUTCOMES.REPLAYED;
  readonly status: number;
}

export interface NotificationMarkReadNotFoundOutcome {
  readonly kind: typeof NOTIFICATION_OUTCOMES.NOT_FOUND;
}

export interface NotificationMarkReadConflictOutcome {
  readonly kind: typeof NOTIFICATION_OUTCOMES.CONFLICT;
}

export type NotificationMarkReadOutcome =
  | NotificationMarkReadNoContentOutcome
  | NotificationMarkReadReplayedOutcome
  | NotificationMarkReadNotFoundOutcome
  | NotificationMarkReadConflictOutcome;

export interface NotificationRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string | null;
  readonly read: boolean;
  readonly actionUrl: string | null;
  readonly createdAt: string;
  readonly cursorAt: string;
}

export interface NotificationStore {
  listNotifications(
    client: TransactionClient,
    subject: string,
    unreadOnly: boolean,
    limit: number,
    cursor?: Cursor,
  ): Promise<readonly NotificationRow[]>;

  markNotificationRead(
    client: TransactionClient,
    subject: string,
    notificationId: string,
    now: Date,
  ): Promise<boolean>;
}

export interface NotificationPort {
  listNotifications(
    subject: string,
    query: NotificationListQuery,
  ): Promise<NotificationListOutcome>;

  markNotificationRead(
    subject: string,
    notificationId: string,
    idempotencyKey: string,
  ): Promise<NotificationMarkReadOutcome>;
}
