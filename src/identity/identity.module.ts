import { Module } from '@nestjs/common';

import { AuthConfig } from './auth-config.js';
import { BOOTSTRAP_PORT } from './bootstrap.port.js';
import { BootstrapService } from './bootstrap.service.js';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { OnboardingController } from './onboarding.controller.js';
import { PgTransaction } from './pg-transaction.js';
import { PostgresConfig } from './postgres-config.js';
import { PostgresPool } from './postgres-pool.js';
import { PostgresBootstrapAdapter } from './postgres-bootstrap.adapter.js';

@Module({
  controllers: [OnboardingController],
  providers: [
    {
      provide: AuthConfig,
      useFactory: (): AuthConfig => AuthConfig.fromEnvironment(process.env),
    },
    {
      provide: JoseJwtVerifier,
      inject: [AuthConfig],
      useFactory: (config: AuthConfig): JoseJwtVerifier =>
        new JoseJwtVerifier(config),
    },
    JwtAuthGuard,
    {
      provide: PostgresPool,
      useFactory: (): PostgresPool =>
        new PostgresPool(() => PostgresConfig.fromEnvironment(process.env)),
    },
    {
      // The inner thunk is load bearing: reading pool.checkoutTimeoutMs eagerly
      // would resolve the pool configuration during module construction and
      // reintroduce the requirement for a reachable database.
      provide: PgTransaction,
      inject: [PostgresPool],
      // prettier-ignore
      useFactory: (pool: PostgresPool): PgTransaction => new PgTransaction(pool, () => ({ checkoutTimeoutMs: pool.checkoutTimeoutMs })),
    },
    PostgresBootstrapAdapter,
    {
      provide: BootstrapService,
      inject: [PgTransaction, PostgresBootstrapAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresBootstrapAdapter,
      ) => new BootstrapService(transaction, adapter),
    },
    { provide: BOOTSTRAP_PORT, useExisting: BootstrapService },
  ],
  exports: [JoseJwtVerifier, JwtAuthGuard, PgTransaction, BOOTSTRAP_PORT],
})
export class IdentityModule {
  public constructor(authConfig: AuthConfig) {
    void authConfig;
  }
}
