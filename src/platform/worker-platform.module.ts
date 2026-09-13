import { Module } from '@nestjs/common';
import { JOB_QUEUE } from './job-queue.port.js';
import { PgTransaction } from './pg-transaction.js';
import { PgmqJobQueueAdapter } from './pgmq-job-queue.adapter.js';
import { PostgresConfig } from './postgres-config.js';
import { PostgresPool } from './postgres-pool.js';
import { WorkerConfig } from './worker-config.js';

@Module({
  providers: [
    {
      provide: WorkerConfig,
      useFactory: (): WorkerConfig => WorkerConfig.fromEnvironment(process.env),
    },
    {
      provide: PostgresPool,
      useFactory: (): PostgresPool =>
        new PostgresPool(() => PostgresConfig.fromEnvironment(process.env)),
    },
    {
      provide: PgTransaction,
      inject: [PostgresPool],
      useFactory: (pool: PostgresPool): PgTransaction =>
        new PgTransaction(
          pool,
          () => ({
            checkoutTimeoutMs: pool.checkoutTimeoutMs,
            statementTimeoutMs: 300_000,
            callbackTimeoutMs: 300_000,
            idleTransactionTimeoutMs: 60_000,
          }),
          { workerMode: true },
        ),
    },
    PgmqJobQueueAdapter,
    {
      provide: JOB_QUEUE,
      useExisting: PgmqJobQueueAdapter,
    },
  ],
  exports: [
    WorkerConfig,
    PostgresPool,
    PgTransaction,
    PgmqJobQueueAdapter,
    JOB_QUEUE,
  ],
})
export class WorkerPlatformModule {}
