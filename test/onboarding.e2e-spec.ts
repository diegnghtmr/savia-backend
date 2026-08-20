import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOTSTRAP_PORT,
  type BootstrapPort,
} from '../src/identity/bootstrap.port.js';
import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import { CommitOutcomeUnknownError } from '../src/identity/pg-transaction.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const TOKEN = 'accepted-token';
const AGGREGATE = {
  profileId: SUBJECT,
  workspaceId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
};
const VALID_BODY = {
  email: 'Person@Example.com',
  displayName: 'Ada Lovelace',
  locale: 'en-US',
  countryCode: 'co',
  timezone: 'America/Bogota',
  dateFormat: 'YYYY-MM-DD',
  weekStartsOn: 1,
  numberFormat: '1,234.56',
  defaultCurrency: 'cop',
  workspaceName: 'Personal',
  baseCurrency: 'cop',
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
  execute: BootstrapPort['execute'],
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(BOOTSTRAP_PORT)
    .useValue({ execute })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function onboard(
  application: NestFastifyApplication,
  options: { body?: Record<string, unknown>; token?: string } = {},
) {
  return application.inject({
    method: 'POST',
    url: '/v1/onboarding',
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
    payload: options.body === undefined ? VALID_BODY : options.body,
  });
}

describe('POST /v1/onboarding', () => {
  it('answers 201 with the aggregate identifiers when onboarding is created', async () => {
    const execute = vi.fn<BootstrapPort['execute']>();
    execute.mockResolvedValue({ kind: 'created', aggregate: AGGREGATE });
    const application = await createApplication(execute);

    const response = await onboard(application, { token: TOKEN });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.payload)).toEqual(AGGREGATE);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      subject: SUBJECT,
      email: 'person@example.com',
      countryCode: 'CO',
      baseCurrency: 'COP',
    });
  });

  it('answers 200 with the aggregate identifiers when onboarding is replayed', async () => {
    const execute = vi.fn<BootstrapPort['execute']>();
    execute.mockResolvedValue({ kind: 'replayed', aggregate: AGGREGATE });
    const application = await createApplication(execute);

    const response = await onboard(application, { token: TOKEN });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.payload)).toEqual(AGGREGATE);
  });

  it('answers 400 problem+json listing the field violations verbatim', async () => {
    const execute = vi.fn<BootstrapPort['execute']>();
    const application = await createApplication(execute);

    const response = await onboard(application, {
      token: TOKEN,
      body: { ...VALID_BODY, email: 'not-an-email', weekStartsOn: 9 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/validation-failed',
      title: 'Request validation failed',
      status: 400,
      code: 'validation-failed',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/onboarding',
      errors: [
        {
          field: 'email',
          code: expect.stringMatching(/.+/),
          message: 'must be a valid email address',
        },
        {
          field: 'weekStartsOn',
          code: expect.stringMatching(/.+/),
          message: 'must be an integer from 0 through 6',
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers 400 problem+json for a malformed JSON request body', async () => {
    const execute = vi.fn<BootstrapPort['execute']>();
    const application = await createApplication(execute);

    const response = await application.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: '{ not valid json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(typeof body.type).toBe('string');
    expect(body.type.length).toBeGreaterThan(0);
    expect(typeof body.title).toBe('string');
    expect(body.title.length).toBeGreaterThan(0);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(0);
    expect(typeof body.traceId).toBe('string');
    expect(body.traceId.length).toBeGreaterThan(0);
    expect(response.payload).not.toContain('{ not valid json');
    expect(response.payload).not.toContain('Body is not valid JSON');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a body-supplied subject so identity comes only from the token', async () => {
    const execute = vi.fn<BootstrapPort['execute']>();
    const application = await createApplication(execute);

    const response = await onboard(application, {
      token: TOKEN,
      body: { ...VALID_BODY, subject: '00000000-0000-4000-8000-000000000000' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).errors).toContainEqual({
      field: 'subject',
      code: expect.stringMatching(/.+/),
      message: 'is not allowed',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([undefined, 'rejected-token'])(
    'answers 401 problem+json without a usable bearer token: %s',
    async (token) => {
      const execute = vi.fn<BootstrapPort['execute']>();
      const application = await createApplication(execute);

      const response = await onboard(application, { token });

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
        instance: '/v1/onboarding',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('answers 409 problem+json when onboarding exists with different data', async () => {
    const execute = vi.fn<BootstrapPort['execute']>();
    execute.mockResolvedValue({ kind: 'different-request' });
    const application = await createApplication(execute);

    const response = await onboard(application, { token: TOKEN });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/onboarding-conflict',
      title: 'Onboarding already exists with different data',
      status: 409,
      code: 'onboarding-conflict',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/onboarding',
    });
  });

  it('answers an opaque 500 problem+json and logs an incomplete aggregate', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const execute = vi.fn<BootstrapPort['execute']>();
    execute.mockResolvedValue({ kind: 'incomplete-aggregate' });
    const application = await createApplication(execute);

    const response = await onboard(application, { token: TOKEN });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/internal',
      title: 'Internal server error',
      status: 500,
      code: 'internal',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/onboarding',
    });
    expect(response.payload).not.toContain('incomplete-aggregate');
    expect(response.payload).not.toContain(SUBJECT);
    const logs = logged.mock.calls.flat(2).join(' ');
    expect(logs).toContain('incomplete-aggregate');
    expect(logs).toContain(SUBJECT);
  });

  it('answers 503 problem+json with Retry-After and logs an unknown commit outcome', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const execute = vi.fn<BootstrapPort['execute']>();
    execute.mockRejectedValue(
      new CommitOutcomeUnknownError(new Error('connection reset by peer')),
    );
    const application = await createApplication(execute);

    const response = await onboard(application, { token: TOKEN });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(String(response.headers['retry-after'])).toMatch(/^\d+$/);
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/outcome-unknown',
      title: 'Onboarding outcome is unknown',
      status: 503,
      code: 'outcome-unknown',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/onboarding',
    });
    expect(response.payload).not.toContain('connection reset by peer');
    // An uncertain write is the one failure an operator must be able to find
    // afterwards, so the log has to carry both who it happened to and why.
    const logs = logged.mock.calls.flat(2).join(' ');
    expect(logs).toContain(SUBJECT);
    expect(logs).toContain('connection reset by peer');
  });

  it('answers an opaque 500 problem+json for an unexpected failure', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const execute = vi.fn<BootstrapPort['execute']>();
    execute.mockRejectedValue(
      new Error('postgresql://savia:hunter2@db.internal:5432 is unreachable'),
    );
    const application = await createApplication(execute);

    const response = await onboard(application, { token: TOKEN });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/internal',
      title: 'Internal server error',
      status: 500,
      code: 'internal',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/onboarding',
    });
    expect(response.payload).not.toContain('hunter2');
    // Assert what was logged, not merely that something logged. A spy on the
    // shared Logger prototype is satisfied by any unrelated call, so only the
    // content proves this filter's catch-all branch is what ran.
    const logs = logged.mock.calls.flat(2).join(' ');
    expect(logs).toContain('Onboarding failed unexpectedly.');
    expect(logs).toContain('hunter2');
  });
});
