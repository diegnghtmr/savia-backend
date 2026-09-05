import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { EXPORTS_PORT } from './export.port.js';
import { ExportService } from './export.service.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
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
        ARTIFACT_STORAGE,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresExportAdapter,
        idem: PostgresIdempotencyAdapter,
        storage: ArtifactStorage,
      ) => new ExportService(tx, store, idem, storage),
    },
    { provide: EXPORTS_PORT, useExisting: ExportService },
  ],
  exports: [EXPORTS_PORT],
})
export class ExportsModule {}
