import type { ExecutionContext } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import { AuthConfig } from '../../src/platform/auth-config.js';
import type { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { JwtAuthGuard } from '../../src/platform/jwt-auth.guard.js';

it('denies a signed MCP-resource JWT on the notification settings routes', async () => {
  const issuer = 'https://auth.example.test';
  const mcpAudience = 'https://mcp.example.test/mcp';
  const config = AuthConfig.fromEnvironment({
    JWT_ISSUER: issuer,
    JWT_AUDIENCE: 'savia-api',
    JWT_JWKS_URI: `${issuer}/jwks`,
    JWT_ALGORITHMS: 'RS256',
    SAVIA_MCP_PROPOSAL_AUDIENCE: mcpAudience,
  });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const verifier = new JoseJwtVerifier(
    config,
    { isActive: async () => true },
    {
      fetch: async () => Response.json({ keys: [{ ...jwk, kid: 'review' }] }),
    },
  );
  const mint = (audience: string) =>
    new SignJWT(
      audience === config.audience
        ? { session_id: '22222222-0000-4000-8000-000000000002' }
        : { mcp_grant_id: '33333333-0000-4000-8000-000000000003' },
    )
      .setProtectedHeader({ alg: 'RS256', kid: 'review' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('11111111-0000-4000-8000-000000000001')
      .setExpirationTime('5m')
      .sign(privateKey);
  const [session, mcp] = await Promise.all([
    mint(config.audience),
    mint(mcpAudience),
  ]);
  const cli = {
    verify: async () => {
      throw new Error('Unexpected CLI verification');
    },
  } as unknown as CliTokenVerifier;
  const guard = new JwtAuthGuard(verifier, cli);
  const context = (method: string, url: string, bearer: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          url,
          routeOptions: { url },
          headers: { authorization: `Bearer ${bearer}` },
        }),
      }),
    }) as unknown as ExecutionContext;
  for (const [method, url] of [
    ['GET', '/v1/me/notification-preferences'],
    ['PUT', '/v1/me/notification-preferences'],
    ['POST', '/v1/me/push-devices'],
    ['DELETE', '/v1/me/push-devices/:deviceId'],
  ]) {
    await expect(
      guard.canActivate(context(method, url, session)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context(method, url, mcp)),
    ).rejects.toMatchObject({ status: 401 });
  }
});
