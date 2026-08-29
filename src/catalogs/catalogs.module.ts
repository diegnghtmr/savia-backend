import { Module } from '@nestjs/common';

import { TagsController } from './tags.controller.js';
import { PayeesController } from './payees.controller.js';
import { CATALOGS_PORT } from './catalogs.port.js';
import { CatalogsService } from './catalogs.service.js';
import { PostgresCatalogsAdapter } from './postgres-catalogs.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [TagsController, PayeesController],
  providers: [
    PostgresCatalogsAdapter,
    {
      provide: CatalogsService,
      inject: [
        PgTransaction,
        PostgresCatalogsAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresCatalogsAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new CatalogsService(transaction, adapter, idempotency),
    },
    { provide: CATALOGS_PORT, useExisting: CatalogsService },
  ],
})
export class CatalogsModule {}
