import type { TransactionClient } from './pg-transaction.js';

export const NOTIFICATION_WRITER = Symbol('NotificationWriter');

export interface NotificationEvent {
  readonly workspaceId: string;
  readonly recipientId: string;
  readonly resourceId: string;
  readonly type: string;
  readonly title: string;
}

export interface NotificationWriter {
  /** Best-effort insert in the originating write transaction; do not publish after it commits. */
  publish(client: TransactionClient, event: NotificationEvent): Promise<void>;
}
