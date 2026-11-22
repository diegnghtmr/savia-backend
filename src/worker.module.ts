import { Module } from '@nestjs/common';
import { buildSubscriptionPriceIncreases } from './analytics/advanced-metrics.js';
import { PostgresAnalyticsAdapter } from './analytics/postgres-analytics.adapter.js';
import { BudgetAlertSweep } from './budgets/budget-alert-sweep.js';
import { PostgresBudgetAdapter } from './budgets/postgres-budget.adapter.js';
import { ForecastJobHandler } from './forecasts/forecast-job.handler.js';
import { ForecastWorkerModule } from './forecasts/forecast-worker.module.js';
import { PostgresJobsAdapter } from './jobs/postgres-jobs.adapter.js';
import { NotificationWriterModule } from './notifications/notification-writer.module.js';
import { PostgresNotificationAdapter } from './notifications/postgres-notification.adapter.js';
import { JOB_HANDLERS } from './platform/job-handler.port.js';
import { JOB_SWEEP, JobRunner } from './platform/job-runner.js';
import {
  NOTIFICATION_WRITER,
  type NotificationWriter,
} from './platform/notification-writer.port.js';
import { JOB_WRITER, type JobWriter } from './platform/job-writer.port.js';
import { PgTransaction } from './platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from './platform/postgres-idempotency.adapter.js';
import { WorkerConfig } from './platform/worker-config.js';
import { PostgresTransactionAdapter } from './ledger/postgres-transaction.adapter.js';
import { TransactionService } from './ledger/transaction.service.js';
import { WorkerPlatformModule } from './platform/worker-platform.module.js';
import { ReportJobHandler } from './reports/report-job.handler.js';
import { ReportWorkerModule } from './reports/report-worker.module.js';
import { ExportJobHandler } from './exports/export-job.handler.js';
import { ExportWorkerModule } from './exports/export-worker.module.js';
import { ReceiptOcrJobHandler } from './receipts/receipt-ocr-job.handler.js';
import { ReceiptWorkerModule } from './receipts/receipt-worker.module.js';
import { RecurringJobSweep } from './recurring/recurring-job-sweep.js';
import { RecurringJobHandler } from './recurring/recurring-job.handler.js';
import { RecurringMaterializer } from './recurring/recurring-materializer.js';
import { PostgresOccurrenceAdapter } from './recurring/postgres-occurrence.adapter.js';
import { SubscriptionDetectionSweep } from './recurring/subscription-detection-sweep.js';

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
    PostgresOccurrenceAdapter,
    {
      provide: RecurringJobSweep,
      inject: [
        PgTransaction,
        PostgresOccurrenceAdapter,
        JOB_WRITER,
        WorkerConfig,
      ],
      useFactory: (
        transaction: PgTransaction,
        store: PostgresOccurrenceAdapter,
        jobs: JobWriter,
        config: WorkerConfig,
      ) =>
        new RecurringJobSweep(transaction, store, jobs, config.queueTimeoutMs),
    },
    {
      provide: BudgetAlertSweep,
      inject: [PgTransaction, PostgresNotificationAdapter, WorkerConfig],
      useFactory: (
        transaction: PgTransaction,
        notifications: PostgresNotificationAdapter,
        config: WorkerConfig,
      ) =>
        new BudgetAlertSweep(
          transaction,
          new PostgresBudgetAdapter(),
          notifications,
          config.queueTimeoutMs,
        ),
    },
    {
      provide: SubscriptionDetectionSweep,
      inject: [PgTransaction, NOTIFICATION_WRITER, WorkerConfig],
      useFactory: (
        transaction: PgTransaction,
        notifications: NotificationWriter,
        config: WorkerConfig,
      ) => {
        const analytics = new PostgresAnalyticsAdapter();
        return new SubscriptionDetectionSweep(
          transaction,
          notifications,
          async (client, workspaceId) =>
            buildSubscriptionPriceIncreases(
              await analytics.readSubscriptionsWithPreviousAmount(
                client,
                workspaceId,
              ),
            ).items,
          config.queueTimeoutMs,
        );
      },
    },
    {
      provide: JOB_SWEEP,
      inject: [RecurringJobSweep, BudgetAlertSweep, SubscriptionDetectionSweep],
      useFactory: (
        recurring: RecurringJobSweep,
        budgetAlerts: BudgetAlertSweep,
        subscriptionDetection: SubscriptionDetectionSweep,
      ) => [recurring, budgetAlerts, subscriptionDetection],
    },
    {
      provide: RecurringJobHandler,
      inject: [PgTransaction, PostgresOccurrenceAdapter],
      useFactory: (
        transaction: PgTransaction,
        store: PostgresOccurrenceAdapter,
      ) =>
        new RecurringJobHandler(
          new RecurringMaterializer(
            store,
            new TransactionService(
              transaction,
              new PostgresTransactionAdapter(),
              new PostgresIdempotencyAdapter(),
            ),
          ),
        ),
    },
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
        RecurringJobHandler,
      ],
      useFactory: (
        forecast: ForecastJobHandler,
        report: ReportJobHandler,
        exportJob: ExportJobHandler,
        receiptOcr: ReceiptOcrJobHandler,
        recurring: RecurringJobHandler,
      ) => [forecast, report, exportJob, receiptOcr, recurring],
    },
    JobRunner,
  ],
  exports: [WorkerPlatformModule, JOB_WRITER, JobRunner, ReportWorkerModule],
})
export class WorkerModule {
  public constructor(private readonly runner: JobRunner) {}

  public drainOnce(): Promise<number> {
    return this.runner.drainOnce();
  }
}
