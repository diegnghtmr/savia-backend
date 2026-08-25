import { Module } from '@nestjs/common';

import { AccountsController } from './accounts.controller.js';
import { ACCOUNTS_PORT } from './accounts.port.js';
import { AccountsService } from './accounts.service.js';
import { PostgresAccountsAdapter } from './postgres-accounts.adapter.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PlatformModule } from '../platform/platform.module.js';

@Module({
  imports: [PlatformModule],
  controllers: [AccountsController],
  providers: [
    PostgresAccountsAdapter,
    {
      provide: AccountsService,
      inject: [
        PgTransaction,
        PostgresAccountsAdapter,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresAccountsAdapter,
        idempotency: PostgresIdempotencyAdapter,
      ) => new AccountsService(transaction, adapter, idempotency),
    },
    { provide: ACCOUNTS_PORT, useExisting: AccountsService },
  ],
})
export class AccountsModule {}
