import { Module } from '@nestjs/common';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { SupabaseStorageAdapter } from '../platform/supabase-storage.adapter.js';
import { ReportJobHandler } from './report-job.handler.js';
import { PostgresReportAdapter } from './postgres-report.adapter.js';

@Module({
  providers: [
    PostgresReportAdapter,
    SupabaseStorageAdapter,
    {
      provide: ARTIFACT_STORAGE,
      useExisting: SupabaseStorageAdapter,
    },
    {
      provide: ReportJobHandler,
      inject: [PostgresReportAdapter, ARTIFACT_STORAGE],
      useFactory: (store: PostgresReportAdapter, storage: ArtifactStorage) =>
        new ReportJobHandler(store, storage),
    },
  ],
  exports: [ReportJobHandler, ARTIFACT_STORAGE],
})
export class ReportWorkerModule {}
