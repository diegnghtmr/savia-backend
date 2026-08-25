import { Module } from '@nestjs/common';

import { AccountsController } from './accounts.controller.js';
import { ACCOUNTS_PORT } from './accounts.port.js';
import { AccountsService } from './accounts.service.js';
import { PostgresAccountsAdapter } from './postgres-accounts.adapter.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PgTransaction } from '../identity/pg-transaction.js';

// PgTransaction and JwtAuthGuard are shared infrastructure imported from
// IdentityModule, never duplicated (no src/shared/ extraction in scope).
@Module({
  imports: [IdentityModule],
  controllers: [AccountsController],
  providers: [
    PostgresAccountsAdapter,
    {
      provide: AccountsService,
      inject: [PgTransaction, PostgresAccountsAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresAccountsAdapter,
      ) => new AccountsService(transaction, adapter),
    },
    { provide: ACCOUNTS_PORT, useExisting: AccountsService },
  ],
})
export class AccountsModule {}
