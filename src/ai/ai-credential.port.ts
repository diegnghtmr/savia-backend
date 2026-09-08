import type { TransactionClient } from '../platform/pg-transaction.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';

export const AI_CREDENTIALS_PORT = Symbol('AI_CREDENTIALS_PORT');
export const AI_OUTCOMES = {
  OK: 'ok',
  CREATED: 'created',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
  PRECONDITION: 'precondition',
} as const;
export type OwnerType = 'user' | 'workspace';
export type CredentialType =
  | 'api_key'
  | 'service_account'
  | 'access_token'
  | 'gateway_token'
  | 'local_endpoint';
export interface CredentialMetadata {
  readonly id: string;
  readonly ownerType: OwnerType;
  readonly providerId: string;
  readonly credentialType: CredentialType | 'oauth';
  readonly maskedIdentifier: string;
  readonly alias: string | null;
  readonly status: 'active' | 'disabled' | 'revoked';
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}
export interface ProviderDescriptor {
  readonly providerId: string;
  readonly displayName: string;
  readonly credentialTypes: readonly string[];
  readonly enabled: boolean;
  readonly policyStatus:
    | 'approved'
    | 'restricted'
    | 'disabled'
    | 'pending_review';
  readonly models?: readonly string[];
}
export interface CreateCredentialCommand {
  readonly ownerType: OwnerType;
  readonly providerId: string;
  readonly credentialType: CredentialType;
  readonly secret: string;
  readonly alias: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly maskedIdentifier?: string;
}
export interface UpdateCredentialCommand {
  readonly alias?: string | null;
  readonly status?: 'active' | 'disabled';
  readonly replacementSecret?: string;
  readonly maskedIdentifier?: string;
}
export interface Store {
  createId(): string;
  list(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly CredentialMetadata[]>;
  create(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    command: CreateCredentialCommand,
  ): Promise<CredentialMetadata>;
  find(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<
    (CredentialMetadata & { version: number; providerId: string }) | undefined
  >;
  update(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    command: UpdateCredentialCommand,
    expectedVersion: number,
  ): Promise<CredentialMetadata | undefined>;
  revoke(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<boolean>;
  setDefault(
    client: TransactionClient,
    workspaceId: string,
    modelRef: string,
    credentialId: string | null,
  ): Promise<boolean>;
}
export interface AIServicePort {
  listProviders(): readonly ProviderDescriptor[];
  listCredentials(
    subject: string,
    workspaceId: string,
  ): Promise<CredentialMetadata[]>;
  createCredential(
    subject: string,
    workspaceId: string,
    command: CreateCredentialCommand,
    key: string,
  ): Promise<Outcome>;
  updateCredential(
    subject: string,
    workspaceId: string,
    id: string,
    command: UpdateCredentialCommand,
    key: string,
    ifMatch: number,
  ): Promise<Outcome>;
  revokeCredential(
    subject: string,
    workspaceId: string,
    id: string,
    key: string,
  ): Promise<Outcome>;
  setDefaultModel(
    subject: string,
    workspaceId: string,
    modelRef: string,
    credentialId: string | null,
    key: string,
  ): Promise<Outcome>;
}
export type AIIdempotencyStore = IdempotencyStore;
export type Outcome = {
  readonly kind: (typeof AI_OUTCOMES)[keyof typeof AI_OUTCOMES];
  readonly credential?: CredentialMetadata;
  readonly items?: readonly CredentialMetadata[];
};
