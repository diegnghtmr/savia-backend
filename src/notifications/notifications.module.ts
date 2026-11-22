import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NOTIFICATION_PORT } from './notification.port.js';
import { NotificationService } from './notification.service.js';
import { NotificationWriterModule } from './notification-writer.module.js';
import { PostgresNotificationAdapter } from './postgres-notification.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { NotificationSettingsController } from './notification-settings.controller.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { PostgresNotificationSettingsAdapter } from './postgres-notification-settings.adapter.js';

@Module({
  imports: [PlatformModule, NotificationWriterModule],
  controllers: [NotificationsController, NotificationSettingsController],
  providers: [
    PostgresNotificationSettingsAdapter,
    {
      provide: NotificationSettingsService,
      inject: [
        PgTransaction,
        PostgresNotificationSettingsAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresNotificationSettingsAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new NotificationSettingsService(tx, store, idempotency),
    },
    {
      provide: NotificationService,
      inject: [
        PgTransaction,
        PostgresNotificationAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresNotificationAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new NotificationService(tx, store, idempotency),
    },
    { provide: NOTIFICATION_PORT, useExisting: NotificationService },
  ],
  exports: [NOTIFICATION_PORT],
})
export class NotificationsModule {}
