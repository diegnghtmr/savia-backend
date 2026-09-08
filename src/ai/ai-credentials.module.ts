import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { CredentialCrypto } from '../platform/credential-crypto.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { AICredentialsController } from './ai-credentials.controller.js';
import { AI_CREDENTIALS_PORT } from './ai-credential.port.js';
import { AICredentialService } from './ai-credential.service.js';
import { PostgresAICredentialAdapter } from './postgres-ai-credential.adapter.js';
@Module({
  imports: [PlatformModule],
  controllers: [AICredentialsController],
  providers: [
    PostgresAICredentialAdapter,
    {
      provide: AICredentialService,
      inject: [
        PgTransaction,
        PostgresAICredentialAdapter,
        CredentialCrypto,
        PostgresIdempotencyAdapter,
      ],
      useFactory: (
        tx: PgTransaction,
        store: PostgresAICredentialAdapter,
        crypto: CredentialCrypto,
        idempotency: PostgresIdempotencyAdapter,
      ) => new AICredentialService(tx, store, crypto, idempotency),
    },
    { provide: AI_CREDENTIALS_PORT, useExisting: AICredentialService },
  ],
})
export class AICredentialsModule {}
