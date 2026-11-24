import { Global, Module } from '@nestjs/common';
import { NOTIFICATION_WRITER } from '../platform/notification-writer.port.js';
import { PostgresNotificationAdapter } from './postgres-notification.adapter.js';

@Global()
@Module({
  providers: [
    PostgresNotificationAdapter,
    { provide: NOTIFICATION_WRITER, useExisting: PostgresNotificationAdapter },
  ],
  exports: [PostgresNotificationAdapter, NOTIFICATION_WRITER],
})
export class NotificationWriterModule {}
