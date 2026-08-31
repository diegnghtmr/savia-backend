import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { EXPORTS_PORT } from './export.port.js';
import { ExportService } from './export.service.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';
import { SupabaseStorageAdapter } from './supabase-storage.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
@Module({
  imports: [PlatformModule],
  controllers: [ExportsController],
  providers: [
    PostgresExportAdapter,
    SupabaseStorageAdapter,
    {
      provide: ExportService,
      inject: [
        PgTransaction,
        PostgresExportAdapter,
        PostgresIdempotencyAdapter,
        SupabaseStorageAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresExportAdapter,
        idem: PostgresIdempotencyAdapter,
        storage: SupabaseStorageAdapter,
      ) => new ExportService(tx, store, idem, storage),
    },
    { provide: EXPORTS_PORT, useExisting: ExportService },
  ],
  exports: [EXPORTS_PORT],
})
export class ExportsModule {}
