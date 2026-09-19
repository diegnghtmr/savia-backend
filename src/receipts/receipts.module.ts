import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module.js';
import {
  LEDGER_WRITER,
  type LedgerWriter,
} from '../platform/ledger-writer.port.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { JOB_WRITER, type JobWriter } from '../platform/job-writer.port.js';
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
        LEDGER_WRITER,
        JOB_WRITER,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresReceiptAdapter,
        idempotency: PostgresIdempotencyAdapter,
        storage: ArtifactStorage,
        ledgerWriter: LedgerWriter,
        jobWriter: JobWriter,
      ) =>
        new ReceiptService(
          tx,
          store,
          idempotency,
          storage,
          ledgerWriter,
          jobWriter,
        ),
    },
    { provide: RECEIPTS_PORT, useExisting: ReceiptService },
  ],
  exports: [RECEIPTS_PORT],
})
export class ReceiptsModule {}
