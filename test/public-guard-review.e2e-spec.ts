import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CLI_DEVICE_PORT } from '../src/cli-device/cli-device.port.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('keeps the public routes independent of an Authorization header', async () => {
  for (const [key, value] of Object.entries({
    JWT_ISSUER: 'https://issuer.example.test',
    JWT_JWKS_URI: 'https://issuer.example.test/jwks',
    JWT_AUDIENCE: 'savia-api',
    JWT_ALGORITHMS: 'RS256',
    CLI_DEVICE_VERIFICATION_URI: 'https://example.test/device',
  }))
    vi.stubEnv(key, value);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLI_DEVICE_PORT)
    .useValue({
      authorize: async () => ({ sample: 'authorized' }),
      poll: async () => ({ kind: 'invalid' }),
    })
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      exposeHeadRoutes: false,
      genReqId: () => 'fixed-trace',
    }),
  );
  registerProblemFilter(app);
  try {
    await app.init();
    for (const [method, url, payload, status] of [
      ['GET', '/health', undefined, 200],
      ['POST', '/v1/cli/device/authorize', {}, 400],
      ['POST', '/v1/cli/device/authorize', { clientId: 'cli-test' }, 200],
      ['POST', '/v1/cli/device/token', {}, 400],
      [
        'POST',
        '/v1/cli/device/token',
        { clientId: 'cli-test', deviceCode: 'invalid-test-code' },
        400,
      ],
    ] as const) {
      const absent = await app.inject({ method, url, payload });
      expect(absent.statusCode).toBe(status);
      const invalid = await app.inject({
        method,
        url,
        payload,
        headers: { authorization: 'Bearer invalid' },
      });
      expect([
        invalid.statusCode,
        invalid.headers['content-type'],
        invalid.body,
      ]).toEqual([status, absent.headers['content-type'], absent.body]);
    }
  } finally {
    await app.close();
  }
});
