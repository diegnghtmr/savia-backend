import { Module } from '@nestjs/common';
import { BudgetsController } from './budgets.controller.js';
import { BUDGETS_PORT } from './budget.port.js';
import { BudgetService } from './budget.service.js';
import { PostgresBudgetAdapter } from './postgres-budget.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
@Module({
  imports: [PlatformModule],
  controllers: [BudgetsController],
  providers: [
    PostgresBudgetAdapter,
    {
      provide: BudgetService,
      inject: [
        PgTransaction,
        PostgresBudgetAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresBudgetAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new BudgetService(tx, store, idempotency),
    },
    { provide: BUDGETS_PORT, useExisting: BudgetService },
  ],
  exports: [BUDGETS_PORT],
})
export class BudgetsModule {}
