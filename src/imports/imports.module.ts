import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { ImportsController } from './imports.controller.js';
import { IMPORTS_PORT } from './import.port.js';
import {
  IMPORT_COMMIT_CALLBACK_TIMEOUT_MS,
  ImportService,
} from './import.service.js';
import { PostgresImportAdapter } from './postgres-import.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresPool } from '../platform/postgres-pool.js';
import { JOB_WRITER, type JobWriter } from '../platform/job-writer.port.js';
import { LEDGER_WRITER } from '../platform/ledger-writer.port.js';
import type { LedgerWriter } from '../platform/ledger-writer.port.js';
@Module({
  imports: [PlatformModule],
  controllers: [ImportsController],
  providers: [
    PostgresImportAdapter,
    {
      provide: 'IMPORT_COMMIT_TRANSACTION',
      inject: [PostgresPool],
      useFactory: (pool: PostgresPool): PgTransaction =>
        new PgTransaction(pool, {
          // Import commits persist the advertised 10,000-row maximum in
          // bounded set-based statements; keep their deliberate synchronous
          // budget local to the import commit path.
          callbackTimeoutMs: IMPORT_COMMIT_CALLBACK_TIMEOUT_MS,
        }),
    },
    {
      provide: ImportService,
      inject: [
        PgTransaction,
        PostgresImportAdapter,
        PostgresIdempotencyAdapter,
        JOB_WRITER,
        LEDGER_WRITER,
        'IMPORT_COMMIT_TRANSACTION',
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresImportAdapter,
        idem: PostgresIdempotencyAdapter,
        jobs: JobWriter,
        ledger: LedgerWriter,
        commitTx: PgTransaction,
      ) => new ImportService(tx, store, idem, jobs, ledger, commitTx),
    },
    { provide: IMPORTS_PORT, useExisting: ImportService },
  ],
  exports: [IMPORTS_PORT],
})
export class ImportsModule {}
