import { Module } from '@nestjs/common';
import { FundsController } from './funds.controller.js';
import { FUNDS_PORT } from './fund.port.js';
import { FundService } from './fund.service.js';
import { PostgresFundAdapter } from './postgres-fund.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [FundsController],
  providers: [
    PostgresFundAdapter,
    {
      provide: FundService,
      inject: [PgTransaction, PostgresFundAdapter, PostgresIdempotencyAdapter],
      useFactory: (
        tx: PgTransaction,
        store: PostgresFundAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new FundService(tx, store, idempotency),
    },
    { provide: FUNDS_PORT, useExisting: FundService },
  ],
  exports: [FUNDS_PORT],
})
export class FundsModule {}
