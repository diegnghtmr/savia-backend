import { Module } from '@nestjs/common';
import { ForecastJobHandler } from './forecasts/forecast-job.handler.js';
import { ForecastWorkerModule } from './forecasts/forecast-worker.module.js';
import { PostgresJobsAdapter } from './jobs/postgres-jobs.adapter.js';
import { NotificationWriterModule } from './notifications/notification-writer.module.js';
import {
  NotificationDeliverySweep,
  PostgresNotificationDeliveryStore,
} from './notifications/notification-delivery-sweep.js';
import { ResendEmailAdapter } from './notifications/notification-providers.adapter.js';
import { JOB_HANDLERS } from './platform/job-handler.port.js';
import { JobRunner } from './platform/job-runner.js';
import { JOB_WRITER } from './platform/job-writer.port.js';
import { PgTransaction } from './platform/pg-transaction.js';
import { WorkerPlatformModule } from './platform/worker-platform.module.js';
import { ReportJobHandler } from './reports/report-job.handler.js';
import { ReportWorkerModule } from './reports/report-worker.module.js';
import { ExportJobHandler } from './exports/export-job.handler.js';
import { ExportWorkerModule } from './exports/export-worker.module.js';
import { ReceiptOcrJobHandler } from './receipts/receipt-ocr-job.handler.js';
import { ReceiptWorkerModule } from './receipts/receipt-worker.module.js';

@Module({
  imports: [
    WorkerPlatformModule,
    NotificationWriterModule,
    ForecastWorkerModule,
    ReportWorkerModule,
    ExportWorkerModule,
    ReceiptWorkerModule,
  ],
  providers: [
    PostgresJobsAdapter,
    {
      provide: JOB_WRITER,
      useExisting: PostgresJobsAdapter,
    },
    {
      provide: JOB_HANDLERS,
      inject: [
        ForecastJobHandler,
        ReportJobHandler,
        ExportJobHandler,
        ReceiptOcrJobHandler,
      ],
      useFactory: (
        forecast: ForecastJobHandler,
        report: ReportJobHandler,
        exportJob: ExportJobHandler,
        receiptOcr: ReceiptOcrJobHandler,
      ) => [forecast, report, exportJob, receiptOcr],
    },
    JobRunner,
    {
      provide: NotificationDeliverySweep,
      inject: [PgTransaction],
      useFactory: (transaction: PgTransaction) => {
        const email =
          process.env.SAVIA_RESEND_API_KEY?.trim() ||
          process.env.SAVIA_NOTIFICATION_FROM_EMAIL?.trim()
            ? new ResendEmailAdapter({
                baseUrl: process.env.SAVIA_RESEND_BASE_URL,
              })
            : undefined;
        return new NotificationDeliverySweep(
          new PostgresNotificationDeliveryStore(transaction),
          email,
        );
      },
    },
  ],
  exports: [WorkerPlatformModule, JOB_WRITER, JobRunner, ReportWorkerModule],
})
export class WorkerModule {
  public constructor(private readonly runner: JobRunner) {}

  public drainOnce(): Promise<number> {
    return this.runner.drainOnce();
  }
}
