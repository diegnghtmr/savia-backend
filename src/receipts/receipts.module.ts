import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module.js';
import { LEDGER_PORT, type LedgerPort } from '../ledger/ledger.port.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { RECEIPTS_PORT } from './receipt.port.js';
import { ReceiptService } from './receipt.service.js';
import { PostgresReceiptAdapter } from './postgres-receipt.adapter.js';
import { ReceiptsController } from './receipts.controller.js';

@Module({
  imports: [PlatformModule, LedgerModule],
  controllers: [ReceiptsController],
  providers: [
    PostgresReceiptAdapter,
    {
      provide: ReceiptService,
      inject: [
        PgTransaction,
        PostgresReceiptAdapter,
        PostgresIdempotencyAdapter,
        ARTIFACT_STORAGE,
        LEDGER_PORT,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresReceiptAdapter,
        idempotency: PostgresIdempotencyAdapter,
        storage: ArtifactStorage,
        ledger: LedgerPort,
      ) => new ReceiptService(tx, store, idempotency, storage, ledger),
    },
    { provide: RECEIPTS_PORT, useExisting: ReceiptService },
  ],
  exports: [RECEIPTS_PORT],
})
export class ReceiptsModule {}
