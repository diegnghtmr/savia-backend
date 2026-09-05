import { Module } from '@nestjs/common';
import { ForecastsController } from './forecasts.controller.js';
import { FORECASTS_PORT } from './forecast.port.js';
import { ForecastService } from './forecast.service.js';
import { PostgresForecastAdapter } from './postgres-forecast.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { JOB_WRITER, type JobWriter } from '../platform/job-writer.port.js';

@Module({
  imports: [PlatformModule],
  controllers: [ForecastsController],
  providers: [
    PostgresForecastAdapter,
    {
      provide: ForecastService,
      inject: [
        PgTransaction,
        PostgresForecastAdapter,
        PostgresIdempotencyAdapter,
        JOB_WRITER,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresForecastAdapter,
        idempotency: PostgresIdempotencyAdapter,
        jobs: JobWriter,
      ) => new ForecastService(tx, store, idempotency, jobs),
    },
    { provide: FORECASTS_PORT, useExisting: ForecastService },
  ],
  exports: [FORECASTS_PORT],
})
export class ForecastsModule {}
