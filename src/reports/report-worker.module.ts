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
import { WorkerPlatformModule } from '../platform/worker-platform.module.js';

@Module({
  imports: [WorkerPlatformModule],
  providers: [
    PostgresReportAdapter,
    SupabaseStorageAdapter,
    {
      provide: ARTIFACT_STORAGE,
      useExisting: SupabaseStorageAdapter,
    },
    {
      provide: PlaywrightPdfRenderer,
      inject: [WorkerConfig],
      useFactory: (config: WorkerConfig): PlaywrightPdfRenderer =>
        new PlaywrightPdfRenderer({
          renderSettleTimeoutMs: config.renderSettleTimeoutMs,
          rendererLaunchTimeoutMs: config.rendererLaunchTimeoutMs,
        }),
    },
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
        WorkerConfig,
      ],
      useFactory: (
        store: PostgresReportAdapter,
        storage: ArtifactStorage,
        pdfRenderer: PdfRenderer,
        config: WorkerConfig,
      ): ReportJobHandler =>
        new ReportJobHandler(
          store,
          storage,
          pdfRenderer,
          undefined,
          config.renderSettleTimeoutMs,
        ),
    },
  ],
  exports: [
    ReportJobHandler,
    ARTIFACT_STORAGE,
    PlaywrightPdfRenderer,
    PDF_RENDERER,
  ],
})
export class ReportWorkerModule {}
