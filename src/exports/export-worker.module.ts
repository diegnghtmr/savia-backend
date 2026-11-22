import { Module, type DynamicModule } from '@nestjs/common';
import type { ExportReaders } from '../platform/export-reader.port.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { SupabaseStorageAdapter } from '../platform/supabase-storage.adapter.js';
import { ExportJobHandler } from './export-job.handler.js';
import { WorkspaceBackupHandler } from './workspace-backup.handler.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';

@Module({
  providers: [
    SupabaseStorageAdapter,
    WorkspaceBackupHandler,
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
  exports: [ExportJobHandler, WorkspaceBackupHandler, ARTIFACT_STORAGE],
})
export class ExportWorkerModule {
  public static withReaders(readers: ExportReaders): DynamicModule {
    return {
      module: ExportWorkerModule,
      providers: [
        {
          provide: PostgresExportAdapter,
          useFactory: () =>
            new PostgresExportAdapter(undefined, undefined, readers),
        },
      ],
    };
  }
}
