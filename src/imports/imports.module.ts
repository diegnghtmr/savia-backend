import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { ImportsController } from './imports.controller.js';
import { IMPORTS_PORT } from './import.port.js';
import { ImportService } from './import.service.js';
import { PostgresImportAdapter } from './postgres-import.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
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
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresImportAdapter,
        idem: PostgresIdempotencyAdapter,
      ) => new ImportService(tx, store, idem),
    },
    { provide: IMPORTS_PORT, useExisting: ImportService },
  ],
  exports: [IMPORTS_PORT],
})
export class ImportsModule {}
