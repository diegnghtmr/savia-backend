import { Module } from '@nestjs/common';

import { AuthConfig } from './auth-config.js';
import { JoseJwtVerifier } from './jose-jwt-verifier.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

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
  ],
  exports: [JoseJwtVerifier, JwtAuthGuard],
})
export class IdentityModule {
  public constructor(authConfig: AuthConfig) {
    void authConfig;
  }
}
