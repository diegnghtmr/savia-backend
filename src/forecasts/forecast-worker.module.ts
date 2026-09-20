import { Module } from '@nestjs/common';
import { ForecastJobHandler } from './forecast-job.handler.js';
import { PostgresForecastAdapter } from './postgres-forecast.adapter.js';

@Module({
  providers: [PostgresForecastAdapter, ForecastJobHandler],
  exports: [ForecastJobHandler],
})
export class ForecastWorkerModule {}
