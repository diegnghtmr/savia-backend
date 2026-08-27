import { Module } from '@nestjs/common';

import { AccountsModule } from './accounts/accounts.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  controllers: [HealthController],
  imports: [PlatformModule, IdentityModule, AccountsModule, LedgerModule],
})
export class AppModule {}
