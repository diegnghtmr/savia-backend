import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOGS_PORT,
  type CatalogsPort,
  type Payee,
  type Tag,
  type TagCreateOutcome,
  type TagListOutcome,
  type PayeeCreateOutcome,
  type PayeeListOutcome,
} from '../src/catalogs/catalogs.port.js';
import { CatalogsModule } from '../src/catalogs/catalogs.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';

const MOCK_TAG: Tag = {
  id: '00000000-0000-0000-0000-000000001001',
  name: 'Groceries',
  archived: false,
};

const MOCK_PAYEE: Payee = {
  id: '00000000-0000-0000-0000-000000002001',
  name: 'Acme Supermarket',
  archived: false,
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
  overrides: Partial<CatalogsPort> = {},
): Promise<{
  application: NestFastifyApplication;
  port: CatalogsPort;
}> {
  const port: CatalogsPort = {
    createTag:
      overrides.createTag ??
      vi.fn().mockResolvedValue({
        kind: 'created',
        tag: MOCK_TAG,
      } satisfies TagCreateOutcome),
    listTags:
      overrides.listTags ??
      vi.fn().mockResolvedValue({
        kind: 'ok',
        page: {
          items: [MOCK_TAG],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      } satisfies TagListOutcome),
    createPayee:
      overrides.createPayee ??
      vi.fn().mockResolvedValue({
        kind: 'created',
        payee: MOCK_PAYEE,
      } satisfies PayeeCreateOutcome),
    listPayees:
      overrides.listPayees ??
      vi.fn().mockResolvedValue({
        kind: 'ok',
        page: {
          items: [MOCK_PAYEE],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      } satisfies PayeeListOutcome),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [CatalogsModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(CATALOGS_PORT)
    .useValue(port)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { application: app, port };
}

function postTag(
  application: NestFastifyApplication,
  body: unknown,
  options: {
    token?: string;
    workspaceHeader?: string;
    idempotencyKey?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceHeader !== undefined)
    headers['x-workspace-id'] = options.workspaceHeader;
  if (options.idempotencyKey !== undefined)
    headers['idempotency-key'] = options.idempotencyKey;
  return application.inject({
    method: 'POST',
    url: '/v1/tags',
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getTags(
  application: NestFastifyApplication,
  query: Record<string, string | undefined> = {},
  options: {
    token?: string;
    workspaceHeader?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceHeader !== undefined)
    headers['x-workspace-id'] = options.workspaceHeader;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }
  const queryString = searchParams.toString();
  const url = `/v1/tags${queryString ? `?${queryString}` : ''}`;

  return application.inject({
    method: 'GET',
    url,
    headers,
  });
}

function postPayee(
  application: NestFastifyApplication,
  body: unknown,
  options: {
    token?: string;
    workspaceHeader?: string;
    idempotencyKey?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceHeader !== undefined)
    headers['x-workspace-id'] = options.workspaceHeader;
  if (options.idempotencyKey !== undefined)
    headers['idempotency-key'] = options.idempotencyKey;
  return application.inject({
    method: 'POST',
    url: '/v1/payees',
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getPayees(
  application: NestFastifyApplication,
  query: Record<string, string | undefined> = {},
  options: {
    token?: string;
    workspaceHeader?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceHeader !== undefined)
    headers['x-workspace-id'] = options.workspaceHeader;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }
  const queryString = searchParams.toString();
  const url = `/v1/payees${queryString ? `?${queryString}` : ''}`;

  return application.inject({
    method: 'GET',
    url,
    headers,
  });
}

describe('POST /v1/tags', () => {
  it('answers 401 when Authorization header is missing', async () => {
    const { application, port } = await createApplication();
    const response = await postTag(
      application,
      { name: 'Groceries' },
      {
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.createTag).not.toHaveBeenCalled();
  });

  it('answers 401 when bearer token is rejected', async () => {
    const { application, port } = await createApplication();
    const response = await postTag(
      application,
      { name: 'Groceries' },
      {
        token: 'rejected-token',
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.createTag).not.toHaveBeenCalled();
  });

  it('answers 201 with created tag when authenticated', async () => {
    const { application, port } = await createApplication();
    const response = await postTag(
      application,
      { name: 'Groceries' },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.payload)).toEqual(MOCK_TAG);
    expect(port.createTag).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Groceries' },
      IDEMPOTENCY_KEY,
    );
  });
});

describe('GET /v1/tags', () => {
  it('answers 401 when Authorization header is missing', async () => {
    const { application, port } = await createApplication();
    const response = await getTags(
      application,
      {},
      { workspaceHeader: WORKSPACE_ID },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.listTags).not.toHaveBeenCalled();
  });

  it('answers 401 when bearer token is rejected', async () => {
    const { application, port } = await createApplication();
    const response = await getTags(
      application,
      {},
      { token: 'rejected-token', workspaceHeader: WORKSPACE_ID },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.listTags).not.toHaveBeenCalled();
  });

  it('answers 200 with paginated tag page when authenticated', async () => {
    const { application, port } = await createApplication();
    const response = await getTags(
      application,
      { limit: '50' },
      { token: TOKEN, workspaceHeader: WORKSPACE_ID },
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      items: [MOCK_TAG],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    expect(port.listTags).toHaveBeenCalledWith(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 50,
    });
  });
});

describe('POST /v1/payees', () => {
  it('answers 401 when Authorization header is missing', async () => {
    const { application, port } = await createApplication();
    const response = await postPayee(
      application,
      { name: 'Acme Supermarket' },
      {
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.createPayee).not.toHaveBeenCalled();
  });

  it('answers 401 when bearer token is rejected', async () => {
    const { application, port } = await createApplication();
    const response = await postPayee(
      application,
      { name: 'Acme Supermarket' },
      {
        token: 'rejected-token',
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.createPayee).not.toHaveBeenCalled();
  });

  it('answers 201 with created payee when authenticated', async () => {
    const { application, port } = await createApplication();
    const response = await postPayee(
      application,
      { name: 'Acme Supermarket' },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.payload)).toEqual(MOCK_PAYEE);
    expect(port.createPayee).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Acme Supermarket' },
      IDEMPOTENCY_KEY,
    );
  });
});

describe('GET /v1/payees', () => {
  it('answers 401 when Authorization header is missing', async () => {
    const { application, port } = await createApplication();
    const response = await getPayees(
      application,
      {},
      { workspaceHeader: WORKSPACE_ID },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.listPayees).not.toHaveBeenCalled();
  });

  it('answers 401 when bearer token is rejected', async () => {
    const { application, port } = await createApplication();
    const response = await getPayees(
      application,
      {},
      { token: 'rejected-token', workspaceHeader: WORKSPACE_ID },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(port.listPayees).not.toHaveBeenCalled();
  });

  it('answers 200 with paginated payee page when authenticated', async () => {
    const { application, port } = await createApplication();
    const response = await getPayees(
      application,
      { limit: '50' },
      { token: TOKEN, workspaceHeader: WORKSPACE_ID },
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      items: [MOCK_PAYEE],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    expect(port.listPayees).toHaveBeenCalledWith(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 50,
    });
  });
});
