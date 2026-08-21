import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../src/identity/identity.module.js';
import { ProfileService } from '../src/identity/profile.service.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import {
  PROFILE_PORT,
  PROFILE_UPDATE_OUTCOMES,
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
  privacyModeEnabled: false,
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
  update: ProfilePort['update'] = vi.fn().mockResolvedValue({
    kind: PROFILE_UPDATE_OUTCOMES.OK,
    profile: PROFILE,
    version: 2,
  }),
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(PROFILE_PORT)
    .useValue({ read, update })
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

function patchProfile(
  application: NestFastifyApplication,
  payload?: Record<string, unknown> | string,
  options: { token?: string; ifMatch?: string } = {},
) {
  return application.inject({
    method: 'PATCH',
    url: '/v1/me',
    headers: {
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('GET /v1/me', () => {
  it('answers 200 with exactly the seven UserProfile keys when profile exists', async () => {
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
        'privacyModeEnabled',
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

describe('PATCH /v1/me', () => {
  it('answers 200 on a single-field update, asserting the exact key set of the body and the ETag header', async () => {
    const updatedProfile = {
      ...PROFILE,
      displayName: 'Ada Lovelace Updated',
    };
    const update = vi.fn<ProfilePort['update']>().mockResolvedValue({
      kind: PROFILE_UPDATE_OUTCOMES.OK,
      profile: updatedProfile,
      version: 8,
    });
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { displayName: 'Ada Lovelace Updated' },
      { token: TOKEN, ifMatch: '"7"' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['etag']).toBe('"8"');
    const body = JSON.parse(response.payload);
    expect(body).toEqual(updatedProfile);
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'email',
        'displayName',
        'locale',
        'timezone',
        'defaultCurrency',
        'privacyModeEnabled',
      ].sort(),
    );
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      { displayName: 'Ada Lovelace Updated' },
      7,
    );
  });

  it('answers 422 on {}', async () => {
    const update = vi.fn<ProfilePort['update']>();
    const application = await createApplication(undefined, update);

    const response = await patchProfile(application, {}, { token: TOKEN });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body).toMatchObject({
      type: 'https://savia.app/problems/unprocessable',
      title: 'Unprocessable entity',
      status: 422,
      code: 'unprocessable',
      instance: '/v1/me',
    });
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'body',
          code: 'empty-update',
        }),
      ]),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 422 on an unknown property, with code unprocessable and an errors array', async () => {
    const update = vi.fn<ProfilePort['update']>();
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { unknownField: 'not allowed' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body).toMatchObject({
      type: 'https://savia.app/problems/unprocessable',
      title: 'Unprocessable entity',
      status: 422,
      code: 'unprocessable',
      instance: '/v1/me',
    });
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'unknownField',
          code: 'not-allowed',
        }),
      ]),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 412 on a stale If-Match', async () => {
    const update = vi.fn<ProfilePort['update']>().mockResolvedValue({
      kind: PROFILE_UPDATE_OUTCOMES.VERSION_CONFLICT,
    });
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { displayName: 'Ada Lovelace Updated' },
      { token: TOKEN, ifMatch: '"7"' },
    );

    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toMatchObject({
      type: 'https://savia.app/problems/precondition-failed',
      title: 'Precondition failed',
      status: 412,
      code: 'precondition-failed',
      instance: '/v1/me',
    });
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      { displayName: 'Ada Lovelace Updated' },
      7,
    );
  });

  it('answers 200 on If-Match: *', async () => {
    const updatedProfile = {
      ...PROFILE,
      displayName: 'Ada Lovelace Updated',
    };
    const update = vi.fn<ProfilePort['update']>().mockResolvedValue({
      kind: PROFILE_UPDATE_OUTCOMES.OK,
      profile: updatedProfile,
      version: 3,
    });
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { displayName: 'Ada Lovelace Updated' },
      { token: TOKEN, ifMatch: '*' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['etag']).toBe('"3"');
    expect(JSON.parse(response.payload)).toEqual(updatedProfile);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      { displayName: 'Ada Lovelace Updated' },
      undefined,
    );
  });

  it('answers 412 on a malformed If-Match', async () => {
    const update = vi.fn<ProfilePort['update']>();
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { displayName: 'Ada Lovelace Updated' },
      { token: TOKEN, ifMatch: 'unquoted-version-7' },
    );

    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toMatchObject({
      type: 'https://savia.app/problems/precondition-failed',
      title: 'Precondition failed',
      status: 412,
      code: 'precondition-failed',
      instance: '/v1/me',
    });
    expect(update).not.toHaveBeenCalled();
  });

  // Both of these reached the port before, and the oversized one reached
  // PostgreSQL, where `version` is an integer column: it answered SQLSTATE
  // 22003 ("value \"100000000000000000000\" is out of range for type integer"),
  // which escaped to the filter's catch-all and became a 500. A client-supplied
  // header must never be able to do that. "007" is rejected for a different
  // reason: RFC 9110 compares entity-tags by octet equality, so it is simply not
  // the tag "7" and must not be parsed into one.
  it.each([
    ['an out-of-range version', '"99999999999999999999"'],
    ['a zero-padded version', '"007"'],
  ])(
    'answers 412 on %s in If-Match without reaching the port',
    async (_name, ifMatch) => {
      const update = vi.fn<ProfilePort['update']>();
      const application = await createApplication(undefined, update);

      const response = await patchProfile(
        application,
        { displayName: 'Ada Lovelace Updated' },
        { token: TOKEN, ifMatch },
      );

      expect(response.statusCode).toBe(412);
      expect(JSON.parse(response.payload)).toMatchObject({
        code: 'precondition-failed',
        status: 412,
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('answers 404 when the profile is absent', async () => {
    const update = vi.fn<ProfilePort['update']>().mockResolvedValue({
      kind: PROFILE_UPDATE_OUTCOMES.NOT_FOUND,
    });
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { displayName: 'Ada Lovelace Updated' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toMatchObject({
      type: 'https://savia.app/problems/not-found',
      title: 'Profile not found',
      status: 404,
      code: 'not-found',
      instance: '/v1/me',
    });
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      { displayName: 'Ada Lovelace Updated' },
      undefined,
    );
  });

  it('answers 401 problem+json with no bearer token', async () => {
    const update = vi.fn<ProfilePort['update']>();
    const application = await createApplication(undefined, update);

    const response = await patchProfile(application, {
      displayName: 'Ada Lovelace Updated',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toMatchObject({
      type: 'https://savia.app/problems/unauthorized',
      title: 'Authentication is required',
      status: 401,
      code: 'unauthorized',
      instance: '/v1/me',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with an invalid bearer token', async () => {
    const update = vi.fn<ProfilePort['update']>();
    const application = await createApplication(undefined, update);

    const response = await patchProfile(
      application,
      { displayName: 'Ada Lovelace Updated' },
      { token: 'invalid-token' },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toMatchObject({
      type: 'https://savia.app/problems/unauthorized',
      title: 'Authentication is required',
      status: 401,
      code: 'unauthorized',
      instance: '/v1/me',
    });
    expect(update).not.toHaveBeenCalled();
  });
});

// The cases above override PROFILE_PORT, so every one of them proves the route's
// shape against a mock. None of them proves the route is wired to the real
// collaborator -- a controller delegating somewhere else entirely would pass all
// of them. This resolves the token from the unmodified module graph instead.
describe('GET /v1/me wiring', () => {
  it('resolves PROFILE_PORT to the real ProfileService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue(verifier)
      .compile();
    expect(moduleRef.get(PROFILE_PORT)).toBeInstanceOf(ProfileService);
    await moduleRef.close();
  });
});
