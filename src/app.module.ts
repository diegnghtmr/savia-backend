import { Module } from '@nestjs/common';

import { AccountsModule } from './accounts/accounts.module.js';
import { CatalogsModule } from './catalogs/catalogs.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { RecurringModule } from './recurring/recurring.module.js';
import { ReconciliationsModule } from './reconciliations/reconciliations.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { FundsModule } from './funds/funds.module.js';

@Module({
  controllers: [HealthController],
  imports: [
    PlatformModule,
    IdentityModule,
    AccountsModule,
    LedgerModule,
    CurrenciesModule,
    CatalogsModule,
    RecurringModule,
    JobsModule,
    ReconciliationsModule,
    ExportsModule,
    ImportsModule,
    BudgetsModule,
    FundsModule,
  ],
})
export class AppModule {}
