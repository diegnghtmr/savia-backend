import { Module } from '@nestjs/common';
import { ScenariosController } from './scenarios.controller.js';
import { SCENARIOS_PORT } from './scenario.port.js';
import { ScenarioService } from './scenario.service.js';
import { PostgresScenarioAdapter } from './postgres-scenario.adapter.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';

@Module({
  imports: [PlatformModule],
  controllers: [ScenariosController],
  providers: [
    PostgresScenarioAdapter,
    {
      provide: ScenarioService,
      inject: [
        PgTransaction,
        PostgresScenarioAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresScenarioAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new ScenarioService(tx, store, idempotency),
    },
    { provide: SCENARIOS_PORT, useExisting: ScenarioService },
  ],
  exports: [SCENARIOS_PORT],
})
export class ScenariosModule {}
