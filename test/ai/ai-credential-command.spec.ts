import { describe, expect, it } from 'vitest';
import {
  isProviderPolicyAllowed,
  PROVIDERS,
} from '../../src/ai/ai-credential.service.js';
import {
  AICredentialValidationError,
  createCredentialCommand,
  setDefaultModelCommand,
  updateCredentialCommand,
} from '../../src/ai/ai-credential-command.js';

const id = '11111111-1111-4111-8111-111111111111';
const secret = 'secret-value-that-must-never-appear';
const base = () => ({
  ownerType: 'user',
  providerId: 'openai',
  credentialType: 'api_key',
  secret,
});
function errorOf(run: () => unknown): AICredentialValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AICredentialValidationError);
    return error as AICredentialValidationError;
  }
  throw new Error('expected validation to fail');
}
function fields(run: () => unknown): string[] {
  return errorOf(run).violations.map((violation) => violation.field);
}
function assertViolation(run: () => unknown, field: string): void {
  const error = errorOf(run);
  expect(error.violations.map((violation) => violation.field)).toContain(field);
  expect(JSON.stringify(error.violations)).not.toContain(secret);
}

describe('AI credential command validation', () => {
  it('accepts both owner types and rejects invalid or absent ownerType', () => {
    expect(
      createCredentialCommand({ ...base(), ownerType: 'user' }).ownerType,
    ).toBe('user');
    expect(
      createCredentialCommand({ ...base(), ownerType: 'workspace' }).ownerType,
    ).toBe('workspace');
    assertViolation(
      () => createCredentialCommand({ ...base(), ownerType: 'team' }),
      'ownerType',
    );
    const absent = { ...base() };
    delete (absent as Record<string, unknown>).ownerType;
    assertViolation(() => createCredentialCommand(absent), 'ownerType');
  });

  it('accepts every catalogue provider and rejects unknown providers', () => {
    for (const provider of PROVIDERS)
      expect(
        createCredentialCommand({
          ...base(),
          providerId: provider.providerId,
          credentialType: provider.credentialTypes[0],
        }).providerId,
      ).toBe(provider.providerId);
    assertViolation(
      () =>
        createCredentialCommand({ ...base(), providerId: 'unknown-provider' }),
      'providerId',
    );
  });

  it('accepts all five creatable credential types and refuses oauth', () => {
    for (const [providerId, credentialType] of [
      ['openai', 'api_key'],
      ['google', 'service_account'],
      ['local', 'local_endpoint'],
      ['openai-compatible', 'gateway_token'],
      ['google', 'api_key'],
    ] as const)
      expect(
        createCredentialCommand({ ...base(), providerId, credentialType })
          .credentialType,
      ).toBe(credentialType);
    assertViolation(
      () => createCredentialCommand({ ...base(), credentialType: 'oauth' }),
      'credentialType',
    );
  });

  it('accepts every catalogue pair and rejects unsupported provider/type pairs', () => {
    for (const provider of PROVIDERS)
      for (const credentialType of provider.credentialTypes)
        expect(
          createCredentialCommand({
            ...base(),
            providerId: provider.providerId,
            credentialType,
          }),
        ).toMatchObject({ providerId: provider.providerId, credentialType });
    assertViolation(
      () =>
        createCredentialCommand({
          ...base(),
          providerId: 'openai',
          credentialType: 'service_account',
        }),
      'credentialType',
    );
  });

  it('allows approved and restricted policies but refuses disabled and pending review', () => {
    expect(
      isProviderPolicyAllowed({ ...PROVIDERS[0], policyStatus: 'approved' }),
    ).toBe(true);
    expect(
      isProviderPolicyAllowed({ ...PROVIDERS[0], policyStatus: 'restricted' }),
    ).toBe(true);
    expect(
      isProviderPolicyAllowed({ ...PROVIDERS[0], policyStatus: 'disabled' }),
    ).toBe(false);
    expect(
      isProviderPolicyAllowed({
        ...PROVIDERS[0],
        policyStatus: 'pending_review',
      }),
    ).toBe(false);
  });

  it('requires a non-empty string secret without leaking it', () => {
    assertViolation(
      () => createCredentialCommand({ ...base(), secret: '' }),
      'secret',
    );
    const absent = { ...base() };
    delete (absent as Record<string, unknown>).secret;
    assertViolation(() => createCredentialCommand(absent), 'secret');
    assertViolation(
      () => createCredentialCommand({ ...base(), secret: 42 }),
      'secret',
    );
  });

  it('enforces alias length and accepts null', () => {
    expect(
      createCredentialCommand({ ...base(), alias: 'a'.repeat(120) }).alias,
    ).toHaveLength(120);
    assertViolation(
      () => createCredentialCommand({ ...base(), alias: 'a'.repeat(121) }),
      'alias',
    );
    expect(
      createCredentialCommand({ ...base(), alias: null }).alias,
    ).toBeNull();
  });

  it('validates metadata values and rejects unknown top-level keys', () => {
    expect(
      createCredentialCommand({ ...base(), metadata: { region: 'us' } })
        .metadata,
    ).toEqual({ region: 'us' });
    assertViolation(
      () => createCredentialCommand({ ...base(), metadata: { count: 1 } }),
      'metadata.count',
    );
    assertViolation(
      () => createCredentialCommand({ ...base(), unexpected: true }),
      'unexpected',
    );
  });

  it('validates update minProperties, single fields, and status enum', () => {
    for (const input of [
      { alias: null },
      { alias: 'primary' },
      { status: 'active' },
      { status: 'disabled' },
      { replacementSecret: secret },
    ])
      expect(updateCredentialCommand(input)).toBeDefined();
    assertViolation(() => updateCredentialCommand({}), 'body');
    assertViolation(
      () => updateCredentialCommand({ status: 'revoked' }),
      'status',
    );
    assertViolation(
      () => updateCredentialCommand({ replacementSecret: '' }),
      'replacementSecret',
    );
    expect(
      JSON.stringify(
        errorOf(() => updateCredentialCommand({ replacementSecret: '' }))
          .violations,
      ),
    ).not.toContain(secret);
  });

  it('validates the default model reference and optional nullable credentialId', () => {
    expect(setDefaultModelCommand({ modelRef: 'openai:gpt-5' })).toEqual({
      modelRef: 'openai:gpt-5',
      credentialId: null,
    });
    expect(
      setDefaultModelCommand({
        modelRef: 'anthropic:claude-sonnet',
        credentialId: null,
      }).credentialId,
    ).toBeNull();
    expect(
      setDefaultModelCommand({ modelRef: 'openai:gpt-5', credentialId: id })
        .credentialId,
    ).toBe(id);
    for (const modelRef of [
      'gpt-5',
      '-openai:gpt-5',
      'OpenAI:gpt-5',
      'openai:',
    ])
      assertViolation(() => setDefaultModelCommand({ modelRef }), 'modelRef');
    assertViolation(
      () => setDefaultModelCommand({ credentialId: null }),
      'modelRef',
    );
    assertViolation(
      () => setDefaultModelCommand({ modelRef: 'openai:gpt-5', extra: true }),
      'extra',
    );
    assertViolation(
      () =>
        setDefaultModelCommand({
          modelRef: 'openai:gpt-5',
          credentialId: 'bad',
        }),
      'credentialId',
    );
  });

  it('reports field names for non-object bodies', () => {
    expect(fields(() => createCredentialCommand(null))).toContain('body');
    expect(fields(() => updateCredentialCommand([]))).toContain('body');
    expect(fields(() => setDefaultModelCommand('bad'))).toContain('body');
  });
});
