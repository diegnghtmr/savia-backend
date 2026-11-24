import { Inject, Injectable, Module } from '@nestjs/common';
import { FrankfurterFxAdapter } from './currencies/frankfurter-fx.adapter.js';
import { FrankfurterRateJob } from './currencies/frankfurter-rate-job.js';
import { PostgresFrankfurterRateAdapter } from './currencies/postgres-frankfurter-rate.adapter.js';
import { PostgresBudgetAdapter } from './budgets/postgres-budget.adapter.js';
import { PostgresDebtAdapter } from './debts/postgres-debt.adapter.js';
import { ForecastJobHandler } from './forecasts/forecast-job.handler.js';
import { ForecastWorkerModule } from './forecasts/forecast-worker.module.js';
import { PostgresJobsAdapter } from './jobs/postgres-jobs.adapter.js';
import {
  NotificationDeliverySweep,
  PostgresNotificationDeliveryStore,
} from './notifications/notification-delivery-sweep.js';
import {
  ExpoPushAdapter,
  ResendEmailAdapter,
} from './notifications/notification-providers.adapter.js';
import { NotificationWriterModule } from './notifications/notification-writer.module.js';
import { JOB_HANDLERS, type JobHandler } from './platform/job-handler.port.js';
import { JOB_QUEUE, type JobQueue } from './platform/job-queue.port.js';
import { JobRunner } from './platform/job-runner.js';
import { JOB_WRITER, type JobWriter } from './platform/job-writer.port.js';
import { PgTransaction } from './platform/pg-transaction.js';
import { WorkerConfig } from './platform/worker-config.js';
import { WorkerPlatformModule } from './platform/worker-platform.module.js';
import { ReportJobHandler } from './reports/report-job.handler.js';
import { ReportWorkerModule } from './reports/report-worker.module.js';
import { ExportJobHandler } from './exports/export-job.handler.js';
import { ExportWorkerModule } from './exports/export-worker.module.js';
import { WorkspaceBackupHandler } from './exports/workspace-backup.handler.js';
import { ReceiptOcrJobHandler } from './receipts/receipt-ocr-job.handler.js';
import { ReceiptWorkerModule } from './receipts/receipt-worker.module.js';

@Injectable()
class ScheduledWorkerRunner extends JobRunner {
  public constructor(
    @Inject(JOB_QUEUE) queue: JobQueue,
    transaction: PgTransaction,
    @Inject(JOB_WRITER) writer: JobWriter,
    config: WorkerConfig,
    @Inject(JOB_HANDLERS) handlers: readonly JobHandler[],
    private readonly fx: FrankfurterRateJob,
  ) {
    super(queue, transaction, writer, config, handlers);
  }

  public override start(): Promise<void> {
    const started = super.start();
    // Keep application-context creation and one-shot queue drains inert.
    this.fx.start();
    return started;
  }

  public override async stop(): Promise<void> {
    await Promise.all([super.stop(), this.fx.stop()]);
  }
}

@Module({
  imports: [
    WorkerPlatformModule,
    NotificationWriterModule,
    ForecastWorkerModule,
    ReportWorkerModule,
    ExportWorkerModule.withReaders({
      budgets: new PostgresBudgetAdapter(),
      debts: new PostgresDebtAdapter(),
    }),
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
        WorkspaceBackupHandler,
        ReceiptOcrJobHandler,
      ],
      useFactory: (
        forecast: ForecastJobHandler,
        report: ReportJobHandler,
        exportJob: ExportJobHandler,
        workspaceBackup: WorkspaceBackupHandler,
        receiptOcr: ReceiptOcrJobHandler,
      ) => [forecast, report, exportJob, workspaceBackup, receiptOcr],
    },
    {
      provide: FrankfurterRateJob,
      inject: [PgTransaction],
      useFactory: (transaction: PgTransaction) =>
        new FrankfurterRateJob(
          new FrankfurterFxAdapter(process.env.SAVIA_FRANKFURTER_BASE_URL),
          new PostgresFrankfurterRateAdapter(transaction),
        ),
    },
    { provide: JobRunner, useClass: ScheduledWorkerRunner },
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
          new ExpoPushAdapter({ baseUrl: process.env.SAVIA_EXPO_BASE_URL }),
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
