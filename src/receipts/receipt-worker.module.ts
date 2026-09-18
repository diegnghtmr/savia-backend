import { Module, type OnModuleInit } from '@nestjs/common';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { OCR_ENGINE, type OcrEnginePort } from '../platform/ocr-engine.port.js';
import { SupabaseStorageAdapter } from '../platform/supabase-storage.adapter.js';
import {
  SystemTesseractAdapter,
  runOcrStartupPreflight,
} from '../platform/system-tesseract.adapter.js';
import { WorkerPlatformModule } from '../platform/worker-platform.module.js';
import { PostgresReceiptAdapter } from './postgres-receipt.adapter.js';
import { ReceiptOcrJobHandler } from './receipt-ocr-job.handler.js';

@Module({
  imports: [WorkerPlatformModule],
  providers: [
    PostgresReceiptAdapter,
    SupabaseStorageAdapter,
    {
      provide: ARTIFACT_STORAGE,
      useExisting: SupabaseStorageAdapter,
    },
    SystemTesseractAdapter,
    {
      provide: OCR_ENGINE,
      useExisting: SystemTesseractAdapter,
    },
    {
      provide: ReceiptOcrJobHandler,
      inject: [PostgresReceiptAdapter, ARTIFACT_STORAGE, OCR_ENGINE],
      useFactory: (
        store: PostgresReceiptAdapter,
        storage: ArtifactStorage,
        ocrEngine: OcrEnginePort,
      ): ReceiptOcrJobHandler =>
        new ReceiptOcrJobHandler(store, storage, ocrEngine),
    },
  ],
  exports: [ReceiptOcrJobHandler],
})
export class ReceiptWorkerModule implements OnModuleInit {
  public async onModuleInit(): Promise<void> {
    await runOcrStartupPreflight();
  }
}
