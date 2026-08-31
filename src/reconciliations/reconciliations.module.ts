import { Module } from '@nestjs/common';

import { ReconciliationsController } from './reconciliations.controller.js';
import { RECONCILIATIONS_PORT } from './reconciliation.port.js';
import { ReconciliationService } from './reconciliation.service.js';
import { PostgresReconciliationAdapter } from './postgres-reconciliation.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { LEDGER_WRITER } from '../platform/ledger-writer.port.js';

@Module({
  imports: [PlatformModule, LedgerModule],
  controllers: [ReconciliationsController],
  providers: [
    PostgresReconciliationAdapter,
    {
      provide: ReconciliationService,
      inject: [
        PgTransaction,
        PostgresReconciliationAdapter,
        PostgresIdempotencyAdapter,
        LEDGER_WRITER,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresReconciliationAdapter,
        idempotency: PostgresIdempotencyAdapter,
        ledgerWriter: import('../platform/ledger-writer.port.js').LedgerWriter,
      ) =>
        new ReconciliationService(
          transaction,
          adapter,
          idempotency,
          ledgerWriter,
        ),
    },
    { provide: RECONCILIATIONS_PORT, useExisting: ReconciliationService },
  ],
  exports: [RECONCILIATIONS_PORT],
})
export class ReconciliationsModule {}
