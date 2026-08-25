import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { exportJWK, generateKeyPair, generateSecret, SignJWT } from 'jose';
import { AuthConfig } from '../../src/platform/auth-config.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { createJwksServer, type JwksServer } from '../helpers/jwks-server.js';
const issuer = 'https://issuer.example.test';
const audience = 'savia-api';
const config = AuthConfig.fromEnvironment({
  JWT_ISSUER: issuer,
  JWT_AUDIENCE: audience,
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
});
let server: JwksServer | undefined;
afterEach(async () => server?.close());
async function key(): Promise<CryptoKeyPair> {
  return generateKeyPair('RS256');
}
async function publicJwk(signingKey: CryptoKeyPair, kid: string) {
  return Object.assign(await exportJWK(signingKey.publicKey), {
    kid,
    alg: 'RS256',
    use: 'sig',
  });
}
async function verifierFor(keys: unknown[]): Promise<JoseJwtVerifier> {
  server = await createJwksServer({ kind: 'jwks', body: { keys } });
  return new JoseJwtVerifier(config, {
    cooldownDuration: 30,
    fetch: (_input, init) => fetch(server?.uri ?? '', init),
    timeoutDuration: 500,
  });
}
async function token(
  signingKey: CryptoKeyPair,
  claims: Record<string, unknown> = {},
  kid = 'key-1',
): Promise<string> {
  return new SignJWT({
    iss: issuer,
    aud: audience,
    sub: 'subject-123',
    exp: Math.floor(Date.now() / 1000) + 60,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .sign(signingKey.privateKey);
}
async function expectUnauthorized(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toMatchObject({ statusCode: 401 });
}
describe('JoseJwtVerifier', () => {
  it('establishes only the verified non-empty subject', async () => {
    const signingKey = await key();
    const verifier = await verifierFor([await publicJwk(signingKey, 'key-1')]);
    await expect(verifier.verify(await token(signingKey))).resolves.toEqual({
      subject: 'subject-123',
    });
    await expectUnauthorized(verifier.verify('not-a-jwt'));
  });
  it.each([
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['missing expiration', { exp: undefined }],
    ['expired expiration', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['future not-before', { nbf: Math.floor(Date.now() / 1000) + 60 }],
    ['invalid not-before', { nbf: 'not-a-time' }],
    ['wrong issuer', { iss: 'https://other.example.test' }],
    ['wrong audience', { aud: 'other-api' }],
  ])('returns 401 without identity for %s', async (_name, claims) => {
    const signingKey = await key();
    const verifier = await verifierFor([await publicJwk(signingKey, 'key-1')]);
    await expectUnauthorized(verifier.verify(await token(signingKey, claims)));
  });
  it('fails closed for a bad signature and an unknown key', async () => {
    const signingKey = await key();
    const otherKey = await key();
    const verifier = await verifierFor([await publicJwk(otherKey, 'key-1')]);
    await expectUnauthorized(verifier.verify(await token(signingKey)));
    await expectUnauthorized(
      verifier.verify(await token(signingKey, {}, 'unknown-key')),
    );
  });
  it('fails closed for a disallowed algorithm and multiple matching keys', async () => {
    const signingKey = await key();
    const verifier = await verifierFor([
      await publicJwk(signingKey, 'key-1'),
      await publicJwk(signingKey, 'key-1'),
    ]);
    const hmacKey = await generateSecret('HS256');
    const hmacToken = await new SignJWT({
      iss: issuer,
      aud: audience,
      sub: 'subject-123',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .sign(hmacKey);
    await expectUnauthorized(verifier.verify(hmacToken));
    await expectUnauthorized(verifier.verify(await token(signingKey)));
  });
  // Previously this lived in the fails-closed table as a `delay` with no body,
  // so the empty reply was itself invalid JWKS and the case passed whether or
  // not the timeout ever fired -- it would have passed with no timeout at all.
  // The delayed reply is now a VALID JWKS, so the only way to stay unauthorized
  // is for the client's own timeout to fire, and the elapsed time proves the
  // rejection did not come from waiting the server out.
  it('fails closed when the JWKS fetch exceeds its timeout', async () => {
    const signingKey = await key();
    const verifier = await verifierFor([]);
    server?.setResponse({
      kind: 'delay',
      milliseconds: 4_000,
      body: { keys: [await publicJwk(signingKey, 'key-1')] },
    });
    const signedToken = await token(signingKey);
    const started = performance.now();
    await expectUnauthorized(verifier.verify(signedToken));
    expect(performance.now() - started).toBeLessThan(3_000);
  });
  it.each([
    ['network failure', { kind: 'close' }],
    [
      'non-200 response',
      { kind: 'text', statusCode: 503, body: 'unavailable' },
    ],
    ['invalid JSON', { kind: 'text', statusCode: 200, body: '{' }],
    ['malformed JWKS', { kind: 'jwks', body: { keys: null } }],
  ] as const)('fails closed on JWKS %s', async (_name, response) => {
    const signingKey = await key();
    const verifier = await verifierFor([]);
    server?.setResponse(response);
    const signedToken = await token(signingKey);
    if (_name === 'malformed JWKS') {
      await expect(
        jwtVerify(signedToken, createRemoteJWKSet(new URL(server?.uri ?? ''))),
      ).rejects.toMatchObject({ code: 'ERR_JWKS_INVALID' });
    }
    await expectUnauthorized(verifier.verify(signedToken));
  });
  it('uses a fresh cached known key during an outage, rotates after refresh, and does not fetch unknown keys during cooldown', async () => {
    const firstKey = await key();
    const secondKey = await key();
    const verifier = await verifierFor([await publicJwk(firstKey, 'key-1')]);
    await expect(verifier.verify(await token(firstKey))).resolves.toBeDefined();
    server?.setResponse({ kind: 'close' });
    await expect(verifier.verify(await token(firstKey))).resolves.toBeDefined();
    await expectUnauthorized(
      verifier.verify(await token(secondKey, {}, 'key-2')),
    );
    expect(server?.requestCount).toBe(1);
    server?.setResponse({
      kind: 'jwks',
      body: { keys: [await publicJwk(secondKey, 'key-2')] },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    await expect(
      verifier.verify(await token(secondKey, {}, 'key-2')),
    ).resolves.toBeDefined();
  });
});
