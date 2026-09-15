import { Module } from '@nestjs/common';
import { JOB_HANDLERS } from '../platform/job-handler.port.js';
import { ForecastJobHandler } from './forecast-job.handler.js';
import { PostgresForecastAdapter } from './postgres-forecast.adapter.js';

@Module({
  providers: [
    PostgresForecastAdapter,
    ForecastJobHandler,
    {
      provide: JOB_HANDLERS,
      inject: [ForecastJobHandler],
      useFactory: (handler: ForecastJobHandler) => [handler],
    },
  ],
  exports: [JOB_HANDLERS],
})
export class ForecastWorkerModule {}
