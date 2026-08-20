import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import {
  PROFILE_PORT,
  type ProfilePort,
  type UserProfile,
} from '../src/identity/profile.port.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const TOKEN = 'accepted-token';
const PROFILE: UserProfile = {
  id: SUBJECT,
  email: 'ada@example.test',
  displayName: 'Ada Lovelace',
  locale: 'en-US',
  timezone: 'America/Bogota',
  defaultCurrency: 'USD',
};

const authEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
  DATABASE_URL: 'postgresql://user:secret@unreachable.invalid:5432/savia',
};
const authEnvironmentKeys = Object.keys(authEnvironment);
const verifier = {
  verify: (token: string) =>
    token === TOKEN
      ? Promise.resolve({ subject: SUBJECT })
      : Promise.reject(new Error('token rejected')),
};

let originalEnvironment: Record<string, string | undefined>;
let app: NestFastifyApplication | undefined;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    authEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, authEnvironment);
});

afterEach(async () => {
  for (const key of authEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function createApplication(
  read: ProfilePort['read'] = vi.fn().mockResolvedValue(PROFILE),
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(PROFILE_PORT)
    .useValue({ read })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function getProfile(
  application: NestFastifyApplication,
  options: { token?: string } = {},
) {
  return application.inject({
    method: 'GET',
    url: '/v1/me',
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
  });
}

describe('GET /v1/me', () => {
  it('answers 200 with exactly the six UserProfile keys when profile exists', async () => {
    const read = vi.fn<ProfilePort['read']>().mockResolvedValue(PROFILE);
    const application = await createApplication(read);

    const response = await getProfile(application, { token: TOKEN });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    const body = JSON.parse(response.payload);
    expect(body).toEqual(PROFILE);
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'email',
        'displayName',
        'locale',
        'timezone',
        'defaultCurrency',
      ].sort(),
    );
    expect(read).toHaveBeenCalledWith(SUBJECT);
  });

  it('answers 404 problem+json with code not-found when the port resolves undefined', async () => {
    const read = vi.fn<ProfilePort['read']>().mockResolvedValue(undefined);
    const application = await createApplication(read);

    const response = await getProfile(application, { token: TOKEN });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/not-found',
      title: 'Profile not found',
      status: 404,
      code: 'not-found',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/me',
    });
    expect(read).toHaveBeenCalledWith(SUBJECT);
  });

  it('answers 401 problem+json with no bearer token', async () => {
    const read = vi.fn<ProfilePort['read']>();
    const application = await createApplication(read);

    const response = await getProfile(application);

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/unauthorized',
      title: 'Authentication is required',
      status: 401,
      code: 'unauthorized',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/me',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with an invalid bearer token', async () => {
    const read = vi.fn<ProfilePort['read']>();
    const application = await createApplication(read);

    const response = await getProfile(application, { token: 'invalid-token' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/unauthorized',
      title: 'Authentication is required',
      status: 401,
      code: 'unauthorized',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/me',
    });
    expect(read).not.toHaveBeenCalled();
  });
});
