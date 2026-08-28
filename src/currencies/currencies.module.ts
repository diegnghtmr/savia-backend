import { Module } from '@nestjs/common';

import { ExchangeRateController } from './exchange-rate.controller.js';
import { EXCHANGE_RATE_PORT } from './exchange-rate.port.js';
import { ExchangeRateService } from './exchange-rate.service.js';
import { PostgresExchangeRateAdapter } from './postgres-exchange-rate.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [ExchangeRateController],
  providers: [
    PostgresExchangeRateAdapter,
    {
      provide: ExchangeRateService,
      inject: [
        PgTransaction,
        PostgresExchangeRateAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresExchangeRateAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new ExchangeRateService(transaction, adapter, idempotency),
    },
    { provide: EXCHANGE_RATE_PORT, useExisting: ExchangeRateService },
  ],
})
export class CurrenciesModule {}
