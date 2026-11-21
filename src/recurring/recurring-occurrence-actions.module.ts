import { Module } from '@nestjs/common';
import {
  OCCURRENCE_LEDGER_WRITER,
  type OccurrenceLedgerWriter,
} from '../platform/ledger-writer.port.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PostgresOccurrenceActionsAdapter } from './postgres-occurrence-actions.adapter.js';
import { PostgresRecurringAdapter } from './postgres-recurring.adapter.js';
import { RecurringOccurrenceActionsController } from './recurring-occurrence-actions.controller.js';
import { RecurringOccurrenceActionsService } from './recurring-occurrence-actions.service.js';

@Module({
  imports: [PlatformModule],
  controllers: [RecurringOccurrenceActionsController],
  providers: [
    PostgresOccurrenceActionsAdapter,
    PostgresRecurringAdapter,
    {
      provide: RecurringOccurrenceActionsService,
      inject: [
        PgTransaction,
        PostgresRecurringAdapter,
        PostgresOccurrenceActionsAdapter,
        OCCURRENCE_LEDGER_WRITER,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        roles: PostgresRecurringAdapter,
        store: PostgresOccurrenceActionsAdapter,
        ledger: OccurrenceLedgerWriter,
        idempotency: PostgresIdempotencyAdapter,
      ) =>
        new RecurringOccurrenceActionsService(
          transaction,
          roles,
          store,
          ledger,
          idempotency,
        ),
    },
  ],
})
export class RecurringOccurrenceActionsModule {}
