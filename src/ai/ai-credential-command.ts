import {
  add,
  nameValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import type {
  CreateCredentialCommand,
  UpdateCredentialCommand,
} from './ai-credential.port.js';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'azure-openai',
  'openai-compatible',
  'local',
] as const;
const TYPES = [
  'api_key',
  'service_account',
  'access_token',
  'gateway_token',
  'local_endpoint',
] as const;
export class AICredentialValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('AI credential validation failed.');
  }
}
function fail(v: FieldViolation[]): never {
  throw new AICredentialValidationError(Object.freeze(sortViolations(v)));
}
export function createCredentialCommand(
  input: unknown,
): CreateCredentialCommand {
  const v: FieldViolation[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add(v, 'body', 'invalid-type', 'must be an object');
    return fail(v);
  }
  const b = input as Record<string, unknown>;
  for (const key of Object.keys(b))
    if (
      ![
        'ownerType',
        'providerId',
        'credentialType',
        'secret',
        'alias',
        'metadata',
      ].includes(key)
    )
      add(v, key, 'not-allowed', 'is not allowed');
  const ownerType =
    b.ownerType === 'user' || b.ownerType === 'workspace'
      ? b.ownerType
      : (add(v, 'ownerType', 'invalid-value', 'must be user or workspace'),
        'workspace');
  const providerId =
    typeof b.providerId === 'string' &&
    (PROVIDERS as readonly string[]).includes(b.providerId)
      ? b.providerId
      : (add(v, 'providerId', 'invalid-value', 'provider is not supported'),
        '');
  const credentialType = (
    typeof b.credentialType === 'string' &&
    (TYPES as readonly string[]).includes(b.credentialType)
      ? b.credentialType
      : (add(
          v,
          'credentialType',
          'invalid-value',
          'credential type is not creatable',
        ),
        'api_key')
  ) as CreateCredentialCommand['credentialType'];
  const secret =
    typeof b.secret === 'string' && b.secret.length > 0
      ? b.secret
      : (add(v, 'secret', 'invalid-value', 'must be a non-empty string'), '');
  let alias: string | null = null;
  if (b.alias !== undefined && b.alias !== null)
    alias = nameValue(b.alias, 'alias', v, 120);
  else if (b.alias !== undefined)
    add(v, 'alias', 'invalid-type', 'must be a string or null');
  const metadata: Record<string, string> = {};
  if (
    b.metadata !== undefined &&
    b.metadata &&
    typeof b.metadata === 'object' &&
    !Array.isArray(b.metadata)
  )
    for (const [k, x] of Object.entries(b.metadata as Record<string, unknown>))
      if (typeof x === 'string') metadata[k] = x;
      else add(v, `metadata.${k}`, 'invalid-type', 'must be a string');
  else if (b.metadata !== undefined)
    add(v, 'metadata', 'invalid-type', 'must be an object');
  if (v.length) fail(v);
  return { ownerType, providerId, credentialType, secret, alias, metadata };
}
export function updateCredentialCommand(
  input: unknown,
): UpdateCredentialCommand {
  const v: FieldViolation[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add(v, 'body', 'invalid-type', 'must be an object');
    return fail(v);
  }
  const b = input as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!['alias', 'status', 'replacementSecret'].includes(k))
      add(v, k, 'not-allowed', 'is not allowed');
  if (!Object.keys(b).length)
    add(v, 'body', 'invalid-value', 'must not be empty');
  const result: {
    alias?: string | null;
    status?: 'active' | 'disabled';
    replacementSecret?: string;
  } = {};
  if ('alias' in b) {
    if (b.alias !== null && typeof b.alias !== 'string')
      add(v, 'alias', 'invalid-type', 'must be a string or null');
    else result.alias = b.alias as string | null;
  }
  if ('status' in b) {
    if (b.status !== 'active' && b.status !== 'disabled')
      add(v, 'status', 'invalid-value', 'must be active or disabled');
    else result.status = b.status;
  }
  if ('replacementSecret' in b) {
    if (typeof b.replacementSecret !== 'string' || !b.replacementSecret)
      add(
        v,
        'replacementSecret',
        'invalid-value',
        'must be a non-empty string',
      );
    else result.replacementSecret = b.replacementSecret;
  }
  if (v.length) fail(v);
  return result;
}
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
