import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyReply, FastifyRequest, InjectOptions } from 'fastify';
import { of } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { CLI_SCOPE_POLICY } from '../../src/platform/cli-scope-policy.js';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { SessionStatusUnavailableError } from '../../src/platform/postgres-session.store.js';
import type {
  McpProposalIdentity,
  RequestIdentity,
} from '../../src/platform/request-identity.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';
import { mcpAuthEnvironment, mcpTokens } from '../helpers/mcp-jwt.js';
import { authorityMcpReads } from '../helpers/openapi-bundle.js';

const subject = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
// Independent reviewer allowlist: an authority change alone must not widen it.
const declared = new Set([
  'GET /v1/workspaces',
  'GET /v1/accounts',
  'GET /v1/accounts/:accountId/balance',
  'GET /v1/transactions',
  'GET /v1/budgets/:budgetId',
  'GET /v1/funds/:fundId',
  'GET /v1/debts/:debtId/projection',
  'GET /v1/analytics/summary',
  'POST /v1/forecasts/balance',
  'GET /v1/forecasts/:forecastId',
  'POST /v1/scenarios/:scenarioId/runs',
  'POST /v1/report-runs',
  'GET /v1/report-runs/:reportRunId',
  'GET /v1/ai/providers',
]);
const proposalRoute = 'POST /v1/mcp/proposals';
const observedIdentityHeader = 'x-test-mcp-identity';

it('admits MCP only on declared reads and the existing proposal endpoint', async () => {
  const signed = await mcpTokens();
  for (const [name, value] of Object.entries(mcpAuthEnvironment))
    vi.stubEnv(name, value);
  vi.stubEnv('CLI_DEVICE_VERIFICATION_URI', 'https://app.example.test/device');
  let liveGrant = true;
  let omittedCliScope: string | undefined;
  const policy = {
    workspaceId,
    role: 'owner',
    toolAllowlist: [],
    localDay: 1,
    localTime: '12:00',
    schedule: [{ dayOfWeek: 1, startTime: '00:00', endTime: '24:00' }],
  };
  const run = async (
    _actor: string,
    callback: (tx: unknown) => Promise<unknown>,
  ) => callback({ query: async () => ({ rows: liveGrant ? [policy] : [] }) });
  const routes = new Map<
    string,
    { method: InjectOptions['method']; url: string }
  >();
  const adapter = new FastifyAdapter({ exposeHeadRoutes: false });
  adapter.getInstance().addHook('onRoute', ({ method, url }) => {
    for (const verb of [method].flat())
      routes.set(`${verb} ${url}`, {
        method: verb as InjectOptions['method'],
        url,
      });
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JoseJwtVerifier)
    .useValue(signed.verifier)
    .overrideProvider(PgTransaction)
    .useValue({ run, runRead: run })
    .overrideProvider(CliTokenVerifier)
    .useValue({
      verify: async (token: string) => {
        if (token !== 'svt_full' && token !== 'svt_empty')
          throw Error('invalid CLI token');
        return {
          subject,
          authMethod: 'cli_token',
          scopes:
            token === 'svt_full'
              ? Object.values(SAVIA_SCOPES).filter(
                  (scope) => scope !== omittedCliScope,
                )
              : [],
        };
      },
    })
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(adapter);
  // Capture the result after all real guards, but before domain transports or DB I/O.
  app.useGlobalInterceptors({
    intercept(context: ExecutionContext) {
      const http = context.switchToHttp();
      const request = http.getRequest<
        FastifyRequest & {
          identity?: RequestIdentity;
          proposalIdentity?: McpProposalIdentity;
        }
      >();
      const reply = http.getResponse<FastifyReply>();
      const identity =
        request.identity?.authMethod ??
        (request.proposalIdentity ? 'mcp_proposal' : undefined);
      if (identity) void reply.header(observedIdentityHeader, identity);
      void reply.code(200).send({ admitted: true });
      return of(undefined);
    },
  });
  registerProblemFilter(app);
  try {
    await app.init();
    const session = await signed.sign(subject, undefined, {
      aud: mcpAuthEnvironment.JWT_AUDIENCE,
    });
    const mcp = await signed.sign(subject, workspaceId);
    const legacy = {
      missing: undefined,
      invalid: 'bad-token',
      session,
      cliFull: 'svt_full',
      cliEmpty: 'svt_empty',
    };
    const expected = new Set(
      [...authorityMcpReads().keys()].filter((route) => routes.has(route)),
    );
    const integrated = process.env.SAVIA_GUARD_BASELINE !== '1';
    if (integrated) {
      expect(expected.size).toBe(14);
      expect(expected).toEqual(declared);
    }
    expected.add(proposalRoute);
    const exercised = new Set<string>();
    const observedReads = new Set<string>();
    const oauthClient = await signed.sign(subject, undefined, {
      aud: mcpAuthEnvironment.JWT_AUDIENCE,
      client_id: 'third-party',
    });
    const publicRoutes = new Set([
      'GET /health',
      'POST /v1/cli/device/authorize',
      'POST /v1/cli/device/token',
    ]);
    const sessionRoutes = new Set([
      'GET /v1/me/sessions',
      'POST /v1/me/sessions/revoke-others',
    ]);
    const cliAllowed = new Set<string>();
    if (integrated) {
      expect(routes.size).toBe(120);
      expect(CLI_SCOPE_POLICY.size).toBe(89);
    }
    for (const [route, { method, url }] of [...routes].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const send = (token?: string) =>
        app.inject({
          method,
          url: url.replaceAll(/:[\w]+/g, workspaceId),
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': workspaceId,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
      const absent = await send();
      if (integrated) {
        const noSession = publicRoutes.has(route) ? 200 : 401;
        expect(absent.statusCode, route).toBe(noSession);
        const cli = await send('svt_full');
        if (cli.headers[observedIdentityHeader] === 'cli_token')
          cliAllowed.add(route);
        const required = CLI_SCOPE_POLICY.get(route);
        if (required) {
          expect(cli.statusCode, route).toBe(200);
          for (const scope of required) {
            omittedCliScope = scope;
            expect(
              (await send('svt_full')).statusCode,
              `${route} minus ${scope}`,
            ).toBe(403);
          }
          omittedCliScope = undefined;
        }
        signed.isActive.mockResolvedValue(true);
        expect((await send(session)).statusCode, route).toBe(
          route === proposalRoute ? 401 : 200,
        );
        signed.isActive.mockResolvedValue(false);
        expect((await send(session)).statusCode, route).toBe(noSession);
        signed.isActive.mockRejectedValue(new SessionStatusUnavailableError());
        const outage = await send(session);
        expect(outage.statusCode, route).toBe(
          sessionRoutes.has(route) ? 503 : noSession,
        );
        if (outage.statusCode === 503)
          expect(outage.json().title).toBe(
            'Session status could not be verified',
          );
        if (outage.statusCode === 401)
          expect(outage.json().title).toBe('Authentication is required');
        const checks = signed.isActive.mock.calls.length;
        expect((await send(oauthClient)).statusCode, route).toBe(noSession);
        expect(signed.isActive).toHaveBeenCalledTimes(checks);
      }
      const sessionChecks = signed.isActive.mock.calls.length;
      const response = await send(mcp);
      expect(signed.isActive).toHaveBeenCalledTimes(sessionChecks);
      if (integrated) {
        const identity = response.headers[observedIdentityHeader];
        if (identity === 'mcp_read') observedReads.add(route);
        if (expected.has(route)) {
          expect(response.statusCode, route).toBe(200);
          expect(identity, route).toBe(
            route === proposalRoute ? 'mcp_proposal' : 'mcp_read',
          );
          exercised.add(route);
          if (route !== proposalRoute) {
            liveGrant = false;
            expect((await send(mcp)).statusCode, route).toBe(403);
            expect(signed.isActive).toHaveBeenCalledTimes(sessionChecks);
            liveGrant = true;
          }
        } else {
          expect(response.statusCode, route).toBe(absent.statusCode);
          expect(identity, route).toBe(absent.headers[observedIdentityHeader]);
          expect(identity, route).not.toBe('mcp_proposal');
        }
      }
      if (process.env.SAVIA_CAPTURE_ROUTE_GUARDS === '1') {
        signed.isActive.mockResolvedValue(true);
        for (const [credential, token] of Object.entries(legacy)) {
          const r = await send(token);
          process.stdout.write(
            `GUARD_DIFF ${JSON.stringify([route, credential, r.statusCode, r.headers['content-type'], r.payload])}\n`,
          );
        }
      }
    }
    if (integrated) {
      expect(exercised).toEqual(expected);
      expect(observedReads).toEqual(declared);
      expect(cliAllowed).toEqual(new Set(CLI_SCOPE_POLICY.keys()));
    }
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
}, 30_000);
