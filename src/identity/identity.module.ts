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
import { PostgresProfileAdapter } from './postgres-profile.adapter.js';
import { PostgresWorkspaceAdapter } from './postgres-workspace.adapter.js';
import { ProfileController } from './profile.controller.js';
import { PROFILE_PORT } from './profile.port.js';
import { ProfileService } from './profile.service.js';
import { IDEMPOTENCY_PORT } from './idempotency.port.js';
import { IdempotencyService } from './idempotency.service.js';
import { PostgresIdempotencyAdapter } from './postgres-idempotency.adapter.js';
import { WorkspaceController } from './workspace.controller.js';
import { WORKSPACE_PORT } from './workspace.port.js';
import { WorkspaceService } from './workspace.service.js';

@Module({
  controllers: [OnboardingController, ProfileController, WorkspaceController],
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
    PostgresProfileAdapter,
    {
      provide: ProfileService,
      inject: [PgTransaction, PostgresProfileAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresProfileAdapter,
      ) => new ProfileService(transaction, adapter),
    },
    { provide: PROFILE_PORT, useExisting: ProfileService },
    PostgresWorkspaceAdapter,
    {
      provide: WorkspaceService,
      inject: [PgTransaction, PostgresWorkspaceAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresWorkspaceAdapter,
      ) => new WorkspaceService(transaction, adapter),
    },
    { provide: WORKSPACE_PORT, useExisting: WorkspaceService },
    PostgresIdempotencyAdapter,
    {
      provide: IdempotencyService,
      inject: [PgTransaction, PostgresIdempotencyAdapter],
      useFactory: (
        transaction: PgTransaction,
        adapter: PostgresIdempotencyAdapter,
      ) => new IdempotencyService(transaction, adapter),
    },
    { provide: IDEMPOTENCY_PORT, useExisting: IdempotencyService },
  ],
  exports: [
    JoseJwtVerifier,
    JwtAuthGuard,
    PgTransaction,
    BOOTSTRAP_PORT,
    PROFILE_PORT,
    WORKSPACE_PORT,
    IDEMPOTENCY_PORT,
  ],
})
export class IdentityModule {
  public constructor(authConfig: AuthConfig) {
    void authConfig;
  }
}
