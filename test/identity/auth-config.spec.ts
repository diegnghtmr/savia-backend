import { describe, expect, it } from 'vitest';

import { AuthConfig } from '../../src/platform/auth-config.js';

const validEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
  JWT_ALGORITHMS: 'RS256,PS256,ES256,EdDSA',
};

describe('AuthConfig', () => {
  it.each([
    ['JWT_ISSUER', ''],
    ['JWT_AUDIENCE', ''],
    ['JWT_JWKS_URI', 'http://issuer.example.test/jwks'],
    ['JWT_JWKS_URI', 'not-a-url'],
    ['JWT_ALGORITHMS', 'HS256'],
    ['JWT_ALGORITHMS', 'RS256,HS256'],
    ['JWT_ALGORITHMS', ''],
  ])('rejects invalid startup configuration: %s=%s', (key, value) => {
    expect(() =>
      AuthConfig.fromEnvironment({ ...validEnvironment, [key]: value }),
    ).toThrow(/JWT configuration/i);
  });

  it('accepts configured issuer, audience, HTTPS JWKS URI, and asymmetric allowlist', () => {
    expect(AuthConfig.fromEnvironment(validEnvironment)).toEqual({
      issuer: 'https://issuer.example.test',
      audience: 'savia-api',
      jwksUri: new URL('https://issuer.example.test/.well-known/jwks.json'),
      algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
    });
  });
});
