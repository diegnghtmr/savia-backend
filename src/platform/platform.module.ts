import { Module } from '@nestjs/common';

import { AuthConfig } from './auth-config.js';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PgTransaction } from './pg-transaction.js';
import { PostgresConfig } from './postgres-config.js';
import { PostgresPool } from './postgres-pool.js';

@Module({
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
      // would resolve the pool configuration during module construction, which
      // requires DATABASE_URL to be present and parseable at boot.
      //
      // Say "present and parseable", not "reachable": PostgresConfig.fromEnvironment
      // only validates and parses the URL string -- it never opens a connection.
      // An eager read with a well-formed but unreachable host succeeds, so a test
      // that merely points DATABASE_URL at an unroutable address proves nothing
      // here. Only DELETING DATABASE_URL distinguishes the two designs, which is
      // what test/health.e2e-spec.ts does.
      provide: PgTransaction,
      inject: [PostgresPool],
      // prettier-ignore
      useFactory: (pool: PostgresPool): PgTransaction => new PgTransaction(pool, () => ({ checkoutTimeoutMs: pool.checkoutTimeoutMs })),
    },
  ],
  exports: [
    AuthConfig,
    JoseJwtVerifier,
    JwtAuthGuard,
    PostgresPool,
    PgTransaction,
  ],
})
export class PlatformModule {
  public constructor(authConfig: AuthConfig) {
    void authConfig;
  }
}
