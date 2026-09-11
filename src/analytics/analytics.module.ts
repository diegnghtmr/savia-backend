import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller.js';
import { ANALYTICS_PORT } from './analytics.port.js';
import { AnalyticsService } from './analytics.service.js';
import { PostgresAnalyticsAdapter } from './postgres-analytics.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';

@Module({
  imports: [PlatformModule],
  controllers: [AnalyticsController],
  providers: [
    PostgresAnalyticsAdapter,
    {
      provide: AnalyticsService,
      inject: [PgTransaction, PostgresAnalyticsAdapter],
      useFactory: (tx: PgTransaction, store: PostgresAnalyticsAdapter) =>
        new AnalyticsService(tx, store),
    },
    { provide: ANALYTICS_PORT, useExisting: AnalyticsService },
  ],
  exports: [ANALYTICS_PORT],
})
export class AnalyticsModule {}
