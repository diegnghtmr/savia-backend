import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NOTIFICATION_PORT } from './notification.port.js';
import { NotificationService } from './notification.service.js';
import { PostgresNotificationAdapter } from './postgres-notification.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [NotificationsController],
  providers: [
    PostgresNotificationAdapter,
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
