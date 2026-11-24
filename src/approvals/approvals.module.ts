import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.js';
import { APPROVALS_PORT, APPROVAL_STORE } from './approval.port.js';
import { ApprovalService } from './approval.service.js';
import { PostgresApprovalAdapter } from './postgres-approval.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import {
  NOTIFICATION_WRITER,
  type NotificationWriter,
} from '../platform/notification-writer.port.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [ApprovalsController],
  providers: [
    PostgresApprovalAdapter,
    { provide: APPROVAL_STORE, useExisting: PostgresApprovalAdapter },
    {
      provide: ApprovalService,
      inject: [
        PgTransaction,
        PostgresApprovalAdapter,
        PostgresIdempotencyAdapter,
        NOTIFICATION_WRITER,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresApprovalAdapter,
        idempotency: PostgresIdempotencyAdapter,
        notifications: NotificationWriter,
      ) =>
        new ApprovalService(tx, store, idempotency, undefined, notifications),
    },
    { provide: APPROVALS_PORT, useExisting: ApprovalService },
  ],
  exports: [APPROVALS_PORT],
})
export class ApprovalsModule {}
