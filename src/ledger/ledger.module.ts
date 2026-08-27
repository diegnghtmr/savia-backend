import { Module } from '@nestjs/common';

import { TransactionController } from './transaction.controller.js';
import { LEDGER_PORT } from './ledger.port.js';
import { TransactionService } from './transaction.service.js';
import { PostgresTransactionAdapter } from './postgres-transaction.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [TransactionController],
  providers: [
    PostgresTransactionAdapter,
    {
      provide: TransactionService,
      inject: [
        PgTransaction,
        PostgresTransactionAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresTransactionAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new TransactionService(transaction, adapter, idempotency),
    },
    { provide: LEDGER_PORT, useExisting: TransactionService },
  ],
})
export class LedgerModule {}
