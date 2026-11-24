import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { AuthConfig } from '../../src/platform/auth-config.js';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { CLI_SCOPE_POLICY } from '../../src/platform/cli-scope-policy.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';
import { mcpAuthEnvironment, mcpTokens } from '../helpers/mcp-jwt.js';

const path = '/v1/mcp/proposals';
const subject = randomUUID();
const grant = randomUUID();
const sessionAudience = mcpAuthEnvironment.JWT_AUDIENCE;
const proposalAudience = mcpAuthEnvironment.SAVIA_MCP_PROPOSAL_AUDIENCE;

async function harness(audience?: string) {
  const env = { ...mcpAuthEnvironment, SAVIA_MCP_PROPOSAL_AUDIENCE: audience };
  const tokens = await mcpTokens(env);
  const cli = vi.fn(async () => ({
    subject,
    authMethod: 'cli_token',
    scopes: Object.values(SAVIA_SCOPES),
  }));
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AuthConfig)
    .useValue(AuthConfig.fromEnvironment(env))
    .overrideProvider(JoseJwtVerifier)
    .useValue(tokens.verifier)
    .overrideProvider(CliTokenVerifier)
    .useValue({ verify: cli })
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, cli, ...tokens };
}

describe('MCP proposal auth boundary', () => {
  it('accepts only the dedicated grant-bound credential; other API guards reject even dual-audience tokens', async () => {
    const { app, cli, sign, isActive, sessionId } =
      await harness(proposalAudience);
    const propose = (token: string) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${token}` },
      });
    const session = await sign(subject, undefined, { aud: sessionAudience });
    const proposal = await sign(subject, grant);
    const dual = await sign(subject, grant, {
      aud: [sessionAudience, proposalAudience],
    });
    const dualWithoutGrant = await sign(subject, undefined, {
      aud: [sessionAudience, proposalAudience],
    });
    try {
      expect((await propose(proposal)).json()).toMatchObject({
        status: 400,
        title: 'Invalid X-Workspace-Id header',
      });
      const invalid = [
        session,
        'svt_cli',
        dual,
        dualWithoutGrant,
        await sign(subject, grant, { aud: 'wrong-resource' }),
        await sign(subject),
        await sign(subject, 'not-a-uuid'),
        await sign(subject, grant, { exp: 1 }),
        await sign(subject, grant, { iss: 'https://wrong.example.test' }),
      ];
      for (const token of invalid) {
        const response = await propose(token);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          code: 'unauthorized',
          instance: path,
          status: 401,
          title: 'Authentication is required',
          traceId: expect.any(String),
          type: 'https://savia.app/problems/unauthorized',
        });
      }
      expect(cli).not.toHaveBeenCalled();
      expect(CLI_SCOPE_POLICY.has(`POST ${path}`)).toBe(false);
      for (const token of [proposal, dual, dualWithoutGrant]) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/approvals/${randomUUID()}/confirm`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      }
      expect(isActive).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/approvals',
        headers: { authorization: `Bearer ${session}` },
      });
      expect(response.json()).toMatchObject({
        status: 400,
        title: 'Invalid X-Workspace-Id header',
      });
      expect(isActive).toHaveBeenCalledExactlyOnceWith(subject, sessionId);
    } finally {
      await app.close();
    }
  });

  it.each([undefined, sessionAudience])(
    'fails closed without a distinct proposal audience (%s)',
    async (audience) => {
      const { app, sign } = await harness(audience);
      try {
        const token = await sign(subject, grant, {
          aud: audience ?? proposalAudience,
        });
        const response = await app.inject({
          method: 'POST',
          url: path,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    },
  );
});
