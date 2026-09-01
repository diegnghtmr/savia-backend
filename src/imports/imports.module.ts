import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { ImportsController } from './imports.controller.js';
import { IMPORTS_PORT } from './import.port.js';
import { ImportService } from './import.service.js';
import { PostgresImportAdapter } from './postgres-import.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { JOB_WRITER, type JobWriter } from '../platform/job-writer.port.js';
import { LEDGER_WRITER } from '../platform/ledger-writer.port.js';
import type { LedgerWriter } from '../platform/ledger-writer.port.js';
@Module({
  imports: [PlatformModule],
  controllers: [ImportsController],
  providers: [
    PostgresImportAdapter,
    {
      provide: ImportService,
      inject: [
        PgTransaction,
        PostgresImportAdapter,
        PostgresIdempotencyAdapter,
        JOB_WRITER,
        LEDGER_WRITER,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresImportAdapter,
        idem: PostgresIdempotencyAdapter,
        jobs: JobWriter,
        ledger: LedgerWriter,
      ) => new ImportService(tx, store, idem, jobs, ledger),
    },
    { provide: IMPORTS_PORT, useExisting: ImportService },
  ],
  exports: [IMPORTS_PORT],
})
export class ImportsModule {}
