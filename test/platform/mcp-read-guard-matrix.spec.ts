import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyReply, InjectOptions } from 'fastify';
import { of } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';
import { mcpAuthEnvironment, mcpTokens } from '../helpers/mcp-jwt.js';
import { authorityMcpReads } from '../helpers/openapi-bundle.js';

const subject = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';

it('admits MCP only on declared reads and the existing proposal endpoint', async () => {
  const signed = await mcpTokens();
  for (const [name, value] of Object.entries(mcpAuthEnvironment))
    vi.stubEnv(name, value);
  vi.stubEnv('CLI_DEVICE_VERIFICATION_URI', 'https://app.example.test/device');
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
  ) => callback({ query: async () => ({ rows: [policy] }) });
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
          scopes: token === 'svt_full' ? Object.values(SAVIA_SCOPES) : [],
        };
      },
    })
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(adapter);
  // Capture the result after all real guards, but before domain transports or DB I/O.
  app.useGlobalInterceptors({
    intercept(context: ExecutionContext) {
      void context
        .switchToHttp()
        .getResponse<FastifyReply>()
        .code(200)
        .send({ admitted: true });
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
    if (process.env.SAVIA_GUARD_BASELINE !== '1') {
      expect(expected.size).toBe(14);
    }
    expected.add('POST /v1/mcp/proposals');
    const exercised = new Set<string>();
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
      const response = await send(mcp);
      if (process.env.SAVIA_GUARD_BASELINE !== '1') {
        if (expected.has(route)) {
          expect(response.statusCode, route).toBe(200);
          exercised.add(route);
        } else {
          expect(response.statusCode, route).toBe(absent.statusCode);
        }
      }
      if (process.env.SAVIA_CAPTURE_ROUTE_GUARDS === '1') {
        for (const [credential, token] of Object.entries(legacy)) {
          const r = await send(token);
          process.stdout.write(
            `GUARD_DIFF ${JSON.stringify([route, credential, r.statusCode, r.headers['content-type'], r.payload])}\n`,
          );
        }
      }
    }
    if (process.env.SAVIA_GUARD_BASELINE !== '1') {
      expect(exercised).toEqual(expected);
    }
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
}, 30_000);
