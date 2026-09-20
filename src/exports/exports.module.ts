import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { EXPORTS_PORT } from './export.port.js';
import { ExportService } from './export.service.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';
import { JOB_WRITER, type JobWriter } from '../platform/job-writer.port.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
@Module({
  imports: [PlatformModule],
  controllers: [ExportsController],
  providers: [
    PostgresExportAdapter,
    {
      provide: ExportService,
      inject: [
        PgTransaction,
        PostgresExportAdapter,
        PostgresIdempotencyAdapter,
        JOB_WRITER,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresExportAdapter,
        idem: PostgresIdempotencyAdapter,
        jobs: JobWriter,
      ) => new ExportService(tx, store, idem, jobs),
    },
    { provide: EXPORTS_PORT, useExisting: ExportService },
  ],
  exports: [EXPORTS_PORT],
})
export class ExportsModule {}
