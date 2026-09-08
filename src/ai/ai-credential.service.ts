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
    void key;
    try {
      return await this.tx.run(subject, async (c) => {
        const id = this.store.createId();
        try {
          return {
            kind: AI_OUTCOMES.CREATED,
            credential: await this.store.create(c, workspaceId, id, {
              ...command,
              secret: this.crypto.encrypt(command.secret),
            }),
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
    void _key;
    return this.tx.run(subject, (c) =>
      this.store
        .update(
          c,
          workspaceId,
          id,
          {
            ...command,
            replacementSecret:
              command.replacementSecret === undefined
                ? undefined
                : this.crypto.encrypt(command.replacementSecret),
          },
          ifMatch,
        )
        .then((credential) =>
          credential
            ? { kind: AI_OUTCOMES.OK, credential }
            : { kind: AI_OUTCOMES.NOT_FOUND },
        ),
    );
  }
  public async revokeCredential(
    subject: string,
    workspaceId: string,
    id: string,
    _key: string,
  ): Promise<Outcome> {
    void _key;
    return this.tx.run(subject, (c) =>
      this.store
        .revoke(c, workspaceId, id)
        .then((ok) =>
          ok ? { kind: AI_OUTCOMES.OK } : { kind: AI_OUTCOMES.NOT_FOUND },
        ),
    );
  }
  public async setDefaultModel(
    subject: string,
    workspaceId: string,
    modelRef: string,
    credentialId: string | null,
    _key: string,
  ): Promise<Outcome> {
    void _key;
    return this.tx.run(subject, async (c) => ({
      kind: (await this.store.setDefault(
        c,
        workspaceId,
        modelRef,
        credentialId,
      ))
        ? AI_OUTCOMES.OK
        : AI_OUTCOMES.CONFLICT,
    }));
  }
}
function isUnique(e: unknown): boolean {
  return e instanceof Error && 'code' in e && String(e.code) === '23505';
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
