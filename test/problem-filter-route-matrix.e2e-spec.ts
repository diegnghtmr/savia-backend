import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest, InjectOptions } from 'fastify';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { BootstrapCommandValidationError } from '../src/identity/bootstrap-command.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { CommitOutcomeUnknownError } from '../src/platform/pg-transaction.js';

it('applies the same private problem filter to every registered HTTP route', async () => {
  vi.stubEnv('JWT_ISSUER', 'https://issuer.example.test');
  vi.stubEnv('JWT_AUDIENCE', 'savia-api');
  vi.stubEnv('JWT_JWKS_URI', 'https://issuer.example.test/jwks');
  vi.stubEnv('JWT_ALGORITHMS', 'RS256');
  const routes = new Map<
    string,
    { method: InjectOptions['method']; url: string }
  >();
  const traceId = 'b8-fixed-trace';
  const adapter = new FastifyAdapter({
    exposeHeadRoutes: false,
    genReqId: () => traceId,
  });
  adapter.getInstance().addHook('onRoute', ({ method, url }) => {
    for (const verb of [method].flat())
      routes.set(`${verb} ${url}`, {
        method: verb as InjectOptions['method'],
        url,
      });
  });
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(adapter);
  registerProblemFilter(app);
  const marker = 'b8-PRIVATE-REQUEST-997';
  const errors = [{ field: 'body', code: 'missing', message: 'Required.' }];
  const cases = [
    [
      'validation-failed',
      'Request validation failed',
      400,
      () => new BootstrapCommandValidationError(errors),
      null,
    ],
    [
      'unauthorized',
      'Authentication is required',
      401,
      () => new UnauthorizedException(marker),
      null,
    ],
    ['forbidden', 'Forbidden', 403, () => new ForbiddenException(marker), null],
    [
      'bad-request',
      'Bad request',
      400,
      () => new BadRequestException(marker),
      'bad-request',
    ],
    [
      'bad-request',
      'Bad request',
      400,
      () => new HttpException(marker, 400),
      'bad-request',
    ],
    [
      'internal',
      'Internal server error',
      500,
      () => new Error(marker),
      'internal',
    ],
    [
      'outcome-unknown',
      'Operation outcome is unknown',
      503,
      () => new CommitOutcomeUnknownError(new Error(marker)),
      'outcome-unknown',
    ],
  ] as const;
  app.useGlobalGuards({
    canActivate(context: ExecutionContext) {
      const request = context
        .switchToHttp()
        .getRequest<FastifyRequest & { identity?: { subject: string } }>();
      const fault = request.headers['x-b8-fault'];
      if (fault === undefined) return true;
      request.identity = { subject: marker };
      throw cases[Number(fault)][3]();
    },
  });
  const logger = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => {});
  try {
    await app.init();
    await adapter.getInstance().ready();
    expect(routes.size).toBeGreaterThan(90);
    for (const { method, url } of routes.values()) {
      const path = url.replace(
        /:\w+/gu,
        '00000000-0000-4000-8000-000000008001',
      );
      for (const [index, [code, title, status, , log]] of cases.entries()) {
        const instance = `${path}?note=${marker}`;
        logger.mockClear();
        const response = await app.inject({
          method,
          url: instance,
          headers: { 'x-b8-fault': String(index) },
        });
        const problem = {
          type: `https://savia.app/problems/${code}`,
          title,
          status,
          code,
          traceId,
          instance,
          ...(code === 'validation-failed' ? { errors } : {}),
        };
        expect(response.statusCode, `${method} ${url} ${index}`).toBe(status);
        expect(response.headers['content-type']).toBe(
          'application/problem+json; charset=utf-8',
        );
        expect(response.headers['retry-after']).toBe(
          status === 503 ? '5' : undefined,
        );
        expect(response.payload).toBe(JSON.stringify(problem));
        expect(logger.mock.calls, `${method} ${url} ${index}`).toEqual(
          log ? [[log]] : [],
        );
      }
    }
    logger.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { 'content-type': 'application/json' },
      payload: `{"${marker}":invalid}`,
    });
    expect(response.statusCode).toBe(400);
    expect(logger.mock.calls).toEqual([['bad-request']]);
  } finally {
    logger.mockRestore();
    vi.unstubAllEnvs();
    await app.close();
  }
});
