import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
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
  return {
    verifier: new JoseJwtVerifier(AuthConfig.fromEnvironment(environment), {
      fetch: async () => Response.json({ keys: [jwk] }),
    }),
    sign: (subject: string, grantId?: string, overrides: JWTPayload = {}) =>
      new SignJWT({
        sub: subject,
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: mcpAuthEnvironment.JWT_ISSUER,
        aud: mcpAuthEnvironment.SAVIA_MCP_PROPOSAL_AUDIENCE,
        ...(grantId === undefined ? {} : { mcp_grant_id: grantId }),
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .sign(privateKey),
  };
}
