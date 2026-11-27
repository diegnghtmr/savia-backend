import { add, type FieldViolation } from '../platform/field-validation.js';
import {
  isUsableBearerToken,
  type CredentialMetadata,
} from './ai-credential.port.js';

type SecretField = 'secret' | 'replacementSecret';

export class AICredentialValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('AI credential validation failed.');
  }
}

export function addBearerTokenViolation(
  violations: FieldViolation[],
  type: CredentialMetadata['credentialType'],
  value: string,
  field: SecretField,
): void {
  const bearer =
    type === 'api_key' || type === 'gateway_token' || type === 'access_token';
  if (!bearer || isUsableBearerToken(value)) return;
  add(
    violations,
    field,
    'invalid-value',
    'must contain only visible ASCII characters',
  );
}

export function assertBearerToken(
  type: CredentialMetadata['credentialType'],
  value: string,
  field: SecretField,
): void {
  const violations: FieldViolation[] = [];
  addBearerTokenViolation(violations, type, value, field);
  if (violations.length) {
    throw new AICredentialValidationError(Object.freeze(violations));
  }
}
