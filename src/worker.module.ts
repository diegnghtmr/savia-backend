import { Module } from '@nestjs/common';
import { ForecastJobHandler } from './forecasts/forecast-job.handler.js';
import { ForecastWorkerModule } from './forecasts/forecast-worker.module.js';
import { PostgresJobsAdapter } from './jobs/postgres-jobs.adapter.js';
import { JOB_HANDLERS } from './platform/job-handler.port.js';
import { JobRunner } from './platform/job-runner.js';
import { JOB_WRITER } from './platform/job-writer.port.js';
import { WorkerPlatformModule } from './platform/worker-platform.module.js';
import { ReportJobHandler } from './reports/report-job.handler.js';
import { ReportWorkerModule } from './reports/report-worker.module.js';

@Module({
  imports: [WorkerPlatformModule, ForecastWorkerModule, ReportWorkerModule],
  providers: [
    PostgresJobsAdapter,
    {
      provide: JOB_WRITER,
      useExisting: PostgresJobsAdapter,
    },
    {
      provide: JOB_HANDLERS,
      inject: [ForecastJobHandler, ReportJobHandler],
      useFactory: (forecast: ForecastJobHandler, report: ReportJobHandler) => [
        forecast,
        report,
      ],
    },
    JobRunner,
  ],
  exports: [WorkerPlatformModule, JOB_WRITER, JobRunner],
})
export class WorkerModule {
  public constructor(private readonly runner: JobRunner) {}

  public drainOnce(): Promise<number> {
    return this.runner.drainOnce();
  }
}
