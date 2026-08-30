import { Module } from '@nestjs/common';

import { RecurringRulesController } from './recurring-rules.controller.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import { RECURRING_RULES_PORT } from './recurring.port.js';
import { RecurringService } from './recurring.service.js';
import { PostgresRecurringAdapter } from './postgres-recurring.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [RecurringRulesController, SubscriptionsController],
  providers: [
    PostgresRecurringAdapter,
    {
      provide: RecurringService,
      inject: [
        PgTransaction,
        PostgresRecurringAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresRecurringAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new RecurringService(transaction, adapter, idempotency),
    },
    { provide: RECURRING_RULES_PORT, useExisting: RecurringService },
  ],
  exports: [RECURRING_RULES_PORT],
})
export class RecurringModule {}
