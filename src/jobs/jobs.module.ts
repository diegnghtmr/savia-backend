import { Global, Module } from '@nestjs/common';

import { JobsController } from './jobs.controller.js';
import { JOBS_PORT, JOB_WRITER } from './job.port.js';
import { JobsService } from './jobs.service.js';
import { PostgresJobsAdapter } from './postgres-jobs.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Global()
@Module({
  imports: [PlatformModule],
  controllers: [JobsController],
  providers: [
    PostgresJobsAdapter,
    {
      provide: JobsService,
      inject: [PgTransaction, PostgresJobsAdapter],
      useFactory: (transaction: PgTransaction, adapter: PostgresJobsAdapter) =>
        new JobsService(transaction, adapter),
    },
    { provide: JOBS_PORT, useExisting: JobsService },
    { provide: JOB_WRITER, useExisting: PostgresJobsAdapter },
  ],
  exports: [JOBS_PORT, JOB_WRITER],
})
export class JobsModule {}
