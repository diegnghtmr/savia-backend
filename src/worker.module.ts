import { Module } from '@nestjs/common';
import { PostgresJobsAdapter } from './jobs/postgres-jobs.adapter.js';
import { JobRunner } from './platform/job-runner.js';
import { JOB_WRITER } from './platform/job-writer.port.js';
import { WorkerPlatformModule } from './platform/worker-platform.module.js';

@Module({
  imports: [WorkerPlatformModule],
  providers: [
    PostgresJobsAdapter,
    {
      provide: JOB_WRITER,
      useExisting: PostgresJobsAdapter,
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
