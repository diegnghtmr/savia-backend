import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { vi } from 'vitest';
import { AuthConfig } from '../../src/platform/auth-config.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';

export const mcpAuthEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
  SAVIA_MCP_PROPOSAL_AUDIENCE: 'https://api.example.test/mcp-proposals',
};

export async function mcpTokens(
  environment: Readonly<
    Record<string, string | undefined>
  > = mcpAuthEnvironment,
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const config = AuthConfig.fromEnvironment(environment);
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const isActive = vi
    .fn<(subject: string, sessionId: string) => Promise<boolean>>()
    .mockResolvedValue(true);
  return {
    verifier: new JoseJwtVerifier(
      config,
      { isActive },
      { fetch: async () => Response.json({ keys: [jwk] }) },
    ),
    isActive,
    sessionId,
    sign: (subject: string, grantId?: string, overrides: JWTPayload = {}) =>
      new SignJWT({
        sub: subject,
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: mcpAuthEnvironment.JWT_ISSUER,
        aud: mcpAuthEnvironment.SAVIA_MCP_PROPOSAL_AUDIENCE,
        ...([overrides.aud].flat().includes(config.audience)
          ? { session_id: sessionId }
          : {}),
        ...(grantId === undefined ? {} : { mcp_grant_id: grantId }),
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .sign(privateKey),
  };
}
