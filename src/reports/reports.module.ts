import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { REPORTS_PORT } from './report.port.js';
import { ReportService } from './report.service.js';
import { PostgresReportAdapter } from './postgres-report.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [ReportsController],
  providers: [
    PostgresReportAdapter,
    {
      provide: ReportService,
      inject: [
        PgTransaction,
        PostgresReportAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresReportAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new ReportService(tx, store, idempotency),
    },
    { provide: REPORTS_PORT, useExisting: ReportService },
  ],
  exports: [REPORTS_PORT],
})
export class ReportsModule {}
