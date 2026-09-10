import { Module } from '@nestjs/common';
import { DebtsController } from './debts.controller.js';
import { DEBTS_PORT } from './debt.port.js';
import { DebtService } from './debt.service.js';
import { PostgresDebtAdapter } from './postgres-debt.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [DebtsController],
  providers: [
    PostgresDebtAdapter,
    {
      provide: DebtService,
      inject: [PgTransaction, PostgresDebtAdapter, PostgresIdempotencyAdapter],
      useFactory: (
        tx: PgTransaction,
        store: PostgresDebtAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new DebtService(tx, store, idempotency),
    },
    { provide: DEBTS_PORT, useExisting: DebtService },
  ],
  exports: [DEBTS_PORT],
})
export class DebtsModule {}
