import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

const authEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
};
const authEnvironmentKeys = Object.keys(authEnvironment);
let originalEnvironment: Record<string, string | undefined>;
let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    authEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  // Removing DATABASE_URL proves the module graph builds and serves health
  // without DATABASE_URL configured at all -- this is the ONLY test that pins
  // the lazy timeout thunk in platform.module.ts. Pointing DATABASE_URL at an
  // unreachable host would not: PostgresConfig.fromEnvironment parses the URL
  // and never connects, so an eager read passes that way too. Dropping these
  // two lines would silently remove the coverage.
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  Object.assign(process.env, authEnvironment);
});

afterEach(() => {
  for (const key of authEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('health endpoint', () => {
  it('exposes only GET /health with the documented health payload', async () => {
    const routes: string[] = [];
    const adapter = new FastifyAdapter({ exposeHeadRoutes: false });
    adapter.getInstance().addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      routes.push(...methods.map((method) => `${method} ${route.url}`));
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app =
      moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    registerProblemFilter(app);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
    expect(Object.keys(JSON.parse(health.payload)).sort()).toEqual([
      'status',
      'time',
    ]);
    expect(JSON.parse(health.payload)).toMatchObject({ status: 'ok' });
    expect(JSON.parse(health.payload).time).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Date.parse(JSON.parse(health.payload).time)).not.toBeNaN();

    // Shaped route-miss answer is 500 pending a deliberate decision.
    const unknown = await app.inject({ method: 'GET', url: '/unknown' });
    expect(unknown.statusCode).toBe(500);
    expect(routes).toEqual([
      'GET /health',
      'POST /v1/onboarding',
      'GET /v1/me',
      'PATCH /v1/me',
      'POST /v1/workspaces',
      'GET /v1/workspaces',
      'GET /v1/workspaces/:workspaceId',
      'GET /v1/workspaces/:workspaceId/members',
      'PATCH /v1/workspaces/:workspaceId/members/:memberId',
      'DELETE /v1/workspaces/:workspaceId/members/:memberId',
      'PATCH /v1/workspaces/:workspaceId',
      'DELETE /v1/workspaces/:workspaceId',
      'GET /v1/workspaces/:workspaceId/invitations',
      'POST /v1/workspaces/:workspaceId/invitations',
      'POST /v1/workspaces/:workspaceId/invitations/:invitationId/revoke',
      'GET /v1/accounts',
      'POST /v1/accounts',
      'GET /v1/accounts/:accountId/balance',
      'GET /v1/accounts/:accountId',
      'PATCH /v1/accounts/:accountId',
      'POST /v1/accounts/:accountId/close',
      'GET /v1/transactions',
      'POST /v1/transactions',
      'GET /v1/transactions/:transactionId',
      'PATCH /v1/transactions/:transactionId',
      'POST /v1/transactions/:transactionId/void',
      'POST /v1/transfers',
    ]);

    await app.close();
  });
});
