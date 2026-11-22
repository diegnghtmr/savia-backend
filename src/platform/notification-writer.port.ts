import type {
  ActorWriteTransactionClient,
  TransactionClient,
} from './pg-transaction.js';

export const NOTIFICATION_WRITER = Symbol('NotificationWriter');

export interface NotificationEvent {
  readonly workspaceId: string;
  readonly recipientId: string;
  readonly resourceId: string;
  readonly type: string;
  readonly title: string;
}

export type BudgetThreshold = 80 | 100;

export interface BudgetThresholdNotificationWriter {
  /** Uses a worker-role client; the database binds the alert to the active budget creator. */
  publishBudgetThresholds(
    client: TransactionClient,
    workspaceId: string,
    budgetId: string,
    day: string,
    thresholds: readonly BudgetThreshold[],
  ): Promise<void>;
}

export interface NotificationWriter {
  /** Best-effort insert in the originating write transaction; do not publish after it commits. */
  publish(
    client: ActorWriteTransactionClient,
    event: NotificationEvent,
  ): Promise<void>;
}
