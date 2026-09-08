import { createHash } from 'node:crypto';
import type { CredentialCrypto } from '../platform/credential-crypto.js';
import type { PgTransaction } from '../platform/pg-transaction.js';
import {
  AI_OUTCOMES,
  type AIServicePort,
  type CreateCredentialCommand,
  type Outcome,
  type ProviderDescriptor,
  type Store,
  type UpdateCredentialCommand,
  type AIIdempotencyStore,
} from './ai-credential.port.js';
export const PROVIDERS: readonly ProviderDescriptor[] = Object.freeze([
  {
    providerId: 'openai',
    displayName: 'OpenAI',
    credentialTypes: ['api_key'],
    enabled: true,
    policyStatus: 'approved',
    models: ['gpt-5'],
  },
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    credentialTypes: ['api_key'],
    enabled: true,
    policyStatus: 'approved',
    models: ['claude-sonnet'],
  },
  {
    providerId: 'google',
    displayName: 'Google',
    credentialTypes: ['api_key', 'service_account'],
    enabled: true,
    policyStatus: 'approved',
  },
  {
    providerId: 'azure-openai',
    displayName: 'Azure OpenAI',
    credentialTypes: ['api_key'],
    enabled: true,
    policyStatus: 'approved',
  },
  {
    providerId: 'openai-compatible',
    displayName: 'OpenAI Compatible',
    credentialTypes: ['api_key', 'gateway_token'],
    enabled: true,
    policyStatus: 'restricted',
  },
  {
    providerId: 'local',
    displayName: 'Local',
    credentialTypes: ['local_endpoint'],
    enabled: true,
    policyStatus: 'approved',
  },
]);
export class AIRollbackError extends Error {
  public constructor(public readonly outcome: typeof AI_OUTCOMES.CONFLICT) {
    super('AI credential transaction rollback');
  }
}
export class AICredentialService implements AIServicePort {
  public constructor(
    private readonly tx: PgTransaction,
    private readonly store: Store,
    private readonly crypto: CredentialCrypto,
    private readonly idempotency: AIIdempotencyStore,
  ) {}
  public listProviders(): readonly ProviderDescriptor[] {
    return PROVIDERS;
  }
  public listCredentials(subject: string, workspaceId: string) {
    return this.tx.runRead(subject, (c) =>
      this.store.list(c, workspaceId).then((items) => [...items]),
    );
  }
  public async createCredential(
    subject: string,
    workspaceId: string,
    command: CreateCredentialCommand,
    key: string,
  ): Promise<Outcome> {
    const route = 'POST /v1/ai/credentials';
    const requestFingerprint = fingerprint(command);
    try {
      return await this.tx.run(subject, async (c) => {
        const existing = await this.idempotency.read(
          c,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing)
          return existing.requestFingerprint === requestFingerprint
            ? {
                kind: AI_OUTCOMES.CREATED,
                credential: existing.responseBody as never,
              }
            : { kind: AI_OUTCOMES.CONFLICT };
        const id = this.store.createId();
        try {
          const encrypted = this.crypto.encrypt(command.secret);
          const credential = await this.store.create(c, workspaceId, id, {
            ...command,
            secret: encrypted,
            maskedIdentifier: mask(command.secret),
          });
          if (
            !(await this.idempotency.write(
              c,
              subject,
              route,
              key,
              requestFingerprint,
              201,
              null,
              credential,
              workspaceId,
            ))
          )
            throw new AIRollbackError(AI_OUTCOMES.CONFLICT);
          return {
            kind: AI_OUTCOMES.CREATED,
            credential,
          };
        } catch (e) {
          if (isUnique(e)) return { kind: AI_OUTCOMES.CONFLICT };
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof AIRollbackError) return { kind: e.outcome };
      throw e;
    }
  }
  public async updateCredential(
    subject: string,
    workspaceId: string,
    id: string,
    command: UpdateCredentialCommand,
    _key: string,
    ifMatch: number,
  ): Promise<Outcome> {
    const route = 'PATCH /v1/ai/credentials/{credentialId}';
    const requestFingerprint = fingerprint({ id, command, ifMatch });
    return this.tx
      .run(subject, async (c) => {
        const existing = await this.idempotency.read(
          c,
          subject,
          route,
          _key,
          workspaceId,
        );
        if (existing)
          return existing.requestFingerprint === requestFingerprint
            ? {
                kind: AI_OUTCOMES.OK,
                credential: existing.responseBody as never,
              }
            : { kind: AI_OUTCOMES.CONFLICT };
        const credential = await this.store.update(
          c,
          workspaceId,
          id,
          {
            ...command,
            replacementSecret:
              command.replacementSecret === undefined
                ? undefined
                : this.crypto.encrypt(command.replacementSecret),
            maskedIdentifier:
              command.replacementSecret === undefined
                ? undefined
                : mask(command.replacementSecret),
          },
          ifMatch,
        );
        if (!credential) return { kind: AI_OUTCOMES.PRECONDITION };
        if (
          !(await this.idempotency.write(
            c,
            subject,
            route,
            _key,
            requestFingerprint,
            200,
            null,
            credential,
            workspaceId,
          ))
        )
          throw new AIRollbackError(AI_OUTCOMES.CONFLICT);
        return { kind: AI_OUTCOMES.OK, credential };
      })
      .catch((error: unknown) => {
        if (error instanceof AIRollbackError) return { kind: error.outcome };
        throw error;
      });
  }
  public async revokeCredential(
    subject: string,
    workspaceId: string,
    id: string,
    _key: string,
  ): Promise<Outcome> {
    const route = 'DELETE /v1/ai/credentials/{credentialId}';
    const requestFingerprint = fingerprint({ id });
    return this.tx
      .run(subject, async (c) => {
        const existing = await this.idempotency.read(
          c,
          subject,
          route,
          _key,
          workspaceId,
        );
        if (existing)
          return existing.requestFingerprint === requestFingerprint
            ? { kind: AI_OUTCOMES.OK }
            : { kind: AI_OUTCOMES.CONFLICT };
        if (!(await this.store.revoke(c, workspaceId, id)))
          return { kind: AI_OUTCOMES.NOT_FOUND };
        if (
          !(await this.idempotency.write(
            c,
            subject,
            route,
            _key,
            requestFingerprint,
            204,
            null,
            null,
            workspaceId,
          ))
        )
          throw new AIRollbackError(AI_OUTCOMES.CONFLICT);
        return { kind: AI_OUTCOMES.OK };
      })
      .catch((error: unknown) => {
        if (error instanceof AIRollbackError) return { kind: error.outcome };
        throw error;
      });
  }
  public async setDefaultModel(
    subject: string,
    workspaceId: string,
    modelRef: string,
    credentialId: string | null,
    _key: string,
  ): Promise<Outcome> {
    const route = 'PUT /v1/ai/default-model';
    const requestFingerprint = fingerprint({ modelRef, credentialId });
    return this.tx
      .run(subject, async (c) => {
        const existing = await this.idempotency.read(
          c,
          subject,
          route,
          _key,
          workspaceId,
        );
        if (existing)
          return existing.requestFingerprint === requestFingerprint
            ? { kind: AI_OUTCOMES.OK }
            : { kind: AI_OUTCOMES.CONFLICT };
        if (
          !(await this.store.setDefault(c, workspaceId, modelRef, credentialId))
        )
          return { kind: AI_OUTCOMES.CONFLICT };
        if (
          !(await this.idempotency.write(
            c,
            subject,
            route,
            _key,
            requestFingerprint,
            204,
            null,
            null,
            workspaceId,
          ))
        )
          throw new AIRollbackError(AI_OUTCOMES.CONFLICT);
        return { kind: AI_OUTCOMES.OK };
      })
      .catch((error: unknown) => {
        if (error instanceof AIRollbackError) return { kind: error.outcome };
        throw error;
      });
  }
}
function isUnique(e: unknown): boolean {
  return (
    e instanceof Error &&
    'code' in e &&
    String(e.code) === '23505' &&
    'constraint' in e &&
    String(e.constraint) === 'ai_credentials_unique_alias'
  );
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function mask(secret: string): string {
  return secret.length > 4 ? `••••${secret.slice(-4)}` : '••••';
}
