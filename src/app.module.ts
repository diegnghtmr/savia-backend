import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';

@Module({
  controllers: [HealthController],
  imports: [IdentityModule],
})
export class AppModule {}
