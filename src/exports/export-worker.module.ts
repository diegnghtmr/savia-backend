import { Module } from '@nestjs/common';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { SupabaseStorageAdapter } from '../platform/supabase-storage.adapter.js';
import { ExportJobHandler } from './export-job.handler.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';

@Module({
  providers: [
    PostgresExportAdapter,
    SupabaseStorageAdapter,
    {
      provide: ARTIFACT_STORAGE,
      useExisting: SupabaseStorageAdapter,
    },
    {
      provide: ExportJobHandler,
      inject: [PostgresExportAdapter, ARTIFACT_STORAGE],
      useFactory: (store: PostgresExportAdapter, storage: ArtifactStorage) =>
        new ExportJobHandler(store, storage),
    },
  ],
  exports: [ExportJobHandler, ARTIFACT_STORAGE],
})
export class ExportWorkerModule {}
