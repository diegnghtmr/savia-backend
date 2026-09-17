import { Module } from '@nestjs/common';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import {
  PDF_RENDERER,
  type PdfRenderer,
} from '../platform/pdf-renderer.port.js';
import { PlaywrightPdfRenderer } from '../platform/playwright-pdf-renderer.js';
import { SupabaseStorageAdapter } from '../platform/supabase-storage.adapter.js';
import { ReportJobHandler } from './report-job.handler.js';
import { PostgresReportAdapter } from './postgres-report.adapter.js';
import { WorkerConfig } from '../platform/worker-config.js';

@Module({
  providers: [
    PostgresReportAdapter,
    SupabaseStorageAdapter,
    {
      provide: ARTIFACT_STORAGE,
      useExisting: SupabaseStorageAdapter,
    },
    PlaywrightPdfRenderer,
    {
      provide: PDF_RENDERER,
      useExisting: PlaywrightPdfRenderer,
    },
    {
      provide: ReportJobHandler,
      inject: [
        PostgresReportAdapter,
        ARTIFACT_STORAGE,
        PDF_RENDERER,
        { token: WorkerConfig, optional: true },
      ],
      useFactory: (
        store: PostgresReportAdapter,
        storage: ArtifactStorage,
        pdfRenderer: PdfRenderer,
        config?: WorkerConfig,
      ) =>
        new ReportJobHandler(
          store,
          storage,
          pdfRenderer,
          undefined,
          config?.renderSettleTimeoutMs ?? 2_000,
        ),
    },
  ],
  exports: [ReportJobHandler, ARTIFACT_STORAGE],
})
export class ReportWorkerModule {}
