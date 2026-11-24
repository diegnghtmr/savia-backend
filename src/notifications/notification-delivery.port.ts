export interface NotificationDelivery {
  readonly to: string;
  readonly title: string;
  readonly body: string | null;
  readonly idempotencyKey: string;
}

/** Provider acceptance is not confirmation of end-user receipt. */
export type NotificationDeliveryResult =
  | 'accepted'
  | 'retryable'
  | 'rejected'
  | 'device_not_registered';

export interface NotificationDeliveryPort {
  deliver(message: NotificationDelivery): Promise<NotificationDeliveryResult>;
}
