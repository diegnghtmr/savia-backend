import { Module } from '@nestjs/common';

import { TransactionController } from './transaction.controller.js';
import { TransferController } from './transfer.controller.js';
import { LEDGER_PORT } from './ledger.port.js';
import { TRANSFER_PORT } from './transfer.port.js';
import { TransactionService } from './transaction.service.js';
import { TransferService } from './transfer.service.js';
import { PostgresTransactionAdapter } from './postgres-transaction.adapter.js';
import { PostgresTransferAdapter } from './postgres-transfer.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [TransactionController, TransferController],
  providers: [
    PostgresTransactionAdapter,
    PostgresTransferAdapter,
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
    {
      provide: TransferService,
      inject: [
        PgTransaction,
        PostgresTransferAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresTransferAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new TransferService(transaction, adapter, idempotency),
    },
    { provide: LEDGER_PORT, useExisting: TransactionService },
    { provide: TRANSFER_PORT, useExisting: TransferService },
  ],
})
export class LedgerModule {}
