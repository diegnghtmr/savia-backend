import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import {
  WORKSPACE_PORT,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceCreateOutcome,
  type WorkspaceDeleteOutcome,
  type WorkspacePort,
} from '../src/identity/workspace.port.js';
import { WorkspaceService } from '../src/identity/workspace.service.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';
const IDEMPOTENCY_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01';

const WORKSPACE: Workspace = {
  id: WORKSPACE_ID,
  name: 'Acme Corp',
  kind: 'shared',
  baseCurrency: 'USD',
  role: 'owner',
  createdAt: '2026-07-15T00:00:00.000Z',
  version: 1,
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
  read: WorkspacePort['read'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    workspace: WORKSPACE,
  } satisfies WorkspaceAccess),
  list: WorkspacePort['list'] = vi.fn().mockResolvedValue({
    items: [WORKSPACE],
    pageInfo: {
      hasNextPage: false,
      nextCursor: null,
    },
  }),
  update: WorkspacePort['update'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    workspace: { ...WORKSPACE, name: 'Acme Corp Updated', version: 2 },
    version: 2,
  }),
  create: WorkspacePort['create'] = vi.fn().mockResolvedValue({
    kind: 'created',
    workspace: WORKSPACE,
  } satisfies WorkspaceCreateOutcome),
  deleteOp: WorkspacePort['delete'] = vi.fn().mockResolvedValue({
    kind: 'deleted',
  } satisfies WorkspaceDeleteOutcome),
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(WORKSPACE_PORT)
    .useValue({ read, list, update, create, delete: deleteOp })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function patchWorkspace(
  application: NestFastifyApplication,
  workspaceId: string,
  body: unknown,
  options: { token?: string; ifMatch?: unknown } = {},
) {
  const headers: Record<string, string | string[]> = {};
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.ifMatch !== undefined) {
    headers['if-match'] = options.ifMatch as string | string[];
  }
  return application.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${workspaceId}`,
    headers,
    payload: body as Record<string, unknown>,
  });
}

function getWorkspace(
  application: NestFastifyApplication,
  workspaceId: string,
  options: { token?: string } = {},
) {
  return application.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}`,
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
  });
}

function listWorkspaces(
  application: NestFastifyApplication,
  query: { cursor?: string; limit?: number | string } = {},
  options: { token?: string } = {},
) {
  const params = new URLSearchParams();
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const queryString = params.toString();
  const url = `/v1/workspaces${queryString ? `?${queryString}` : ''}`;
  return application.inject({
    method: 'GET',
    url,
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
  });
}

function postWorkspace(
  application: NestFastifyApplication,
  body: unknown,
  options: { token?: string; idempotencyKey?: string | string[] } = {},
) {
  const headers: Record<string, string | string[]> = {};
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  return application.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers,
    payload: body as string | object | Buffer | NodeJS.ReadableStream,
  });
}

function deleteWorkspace(
  application: NestFastifyApplication,
  workspaceId: string,
  options: { token?: string; idempotencyKey?: string | string[] } = {},
) {
  const headers: Record<string, string | string[]> = {};
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  return application.inject({
    method: 'DELETE',
    url: `/v1/workspaces/${workspaceId}`,
    headers,
  });
}

describe('POST /v1/workspaces', () => {
  it('answers 201 with ETag and workspace body on valid creation', async () => {
    const create = vi.fn<WorkspacePort['create']>().mockResolvedValue({
      kind: 'created',
      workspace: WORKSPACE,
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme Corp', kind: 'shared', baseCurrency: 'USD' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['etag']).toBe('"1"');
    expect(JSON.parse(response.payload)).toEqual(WORKSPACE);
    expect(create).toHaveBeenCalledWith(
      SUBJECT,
      { name: 'Acme Corp', kind: 'shared', baseCurrency: 'USD' },
      IDEMPOTENCY_KEY,
    );
  });

  it('answers 200/201 on replayed outcome reproducing stored status, ETag and body byte-for-byte', async () => {
    const create = vi.fn<WorkspacePort['create']>().mockResolvedValue({
      kind: 'replayed',
      status: 201,
      etag: '"1"',
      body: WORKSPACE,
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme Corp', kind: 'shared', baseCurrency: 'USD' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(201);
    expect(response.headers['etag']).toBe('"1"');
    expect(JSON.parse(response.payload)).toEqual(WORKSPACE);
  });

  it('answers 409 problem+json when the port reports an idempotency conflict', async () => {
    const create = vi.fn<WorkspacePort['create']>().mockResolvedValue({
      kind: 'idempotency-conflict',
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Mutated Name', baseCurrency: 'USD' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/conflict',
      title: 'Idempotency conflict',
      status: 409,
      code: 'conflict',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces',
    });
  });

  it('answers 422 problem+json when kind is personal', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Personal Workspace', kind: 'personal', baseCurrency: 'USD' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe('https://savia.app/problems/unprocessable');
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'kind' }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 422 problem+json for unknown fields (additionalProperties: false)', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme', baseCurrency: 'USD', extraField: 'bogus' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'extraField', code: 'not-allowed' }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 422 problem+json when required name is missing', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { baseCurrency: 'USD' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.payload);
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'name', code: 'required' }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 422 problem+json when required baseCurrency is missing', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.payload);
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'baseCurrency', code: 'required' }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 422 for invalid baseCurrency (USDX, US, 123) and asserts the port was never called', async () => {
    for (const badCurrency of ['USDX', 'US', 'usd1', 'XXZ', 'XXX', '123', '']) {
      const create = vi.fn<WorkspacePort['create']>();
      const application = await createApplication(
        undefined,
        undefined,
        undefined,
        create,
      );

      const response = await postWorkspace(
        application,
        { name: 'Acme', baseCurrency: badCurrency },
        { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
      );

      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('answers 422 for name containing NUL and asserts the port was never called', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme\0Corp', baseCurrency: 'USD' },
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 for missing Idempotency-Key header and asserts the port was never called', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme', baseCurrency: 'USD' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid Idempotency-Key header',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces',
      detail: expect.any(String),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 for duplicated Idempotency-Key header (array) and asserts the port was never called', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme', baseCurrency: 'USD' },
      {
        token: TOKEN,
        idempotencyKey: [
          '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01',
          '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb02',
        ],
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid Idempotency-Key header',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces',
      detail: expect.any(String),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 for non-UUID Idempotency-Key header and asserts the port was never called', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme', baseCurrency: 'USD' },
      {
        token: TOKEN,
        idempotencyKey: 'not-a-uuid',
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid Idempotency-Key header',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces',
      detail: expect.any(String),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with no bearer token', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(application, {
      name: 'Acme',
      baseCurrency: 'USD',
    });

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
      instance: '/v1/workspaces',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with an invalid bearer token', async () => {
    const create = vi.fn<WorkspacePort['create']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      create,
    );

    const response = await postWorkspace(
      application,
      { name: 'Acme', baseCurrency: 'USD' },
      { token: 'invalid-token' },
    );

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
      instance: '/v1/workspaces',
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('GET /v1/workspaces/:workspaceId', () => {
  it('answers 200 with exactly the seven Workspace keys and the ETag header when workspace exists and member is active', async () => {
    const read = vi.fn<WorkspacePort['read']>().mockResolvedValue({
      kind: 'ok',
      workspace: WORKSPACE,
    });
    const application = await createApplication(read);

    const response = await getWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['etag']).toBe('"1"');
    const body = JSON.parse(response.payload);
    expect(body).toEqual(WORKSPACE);
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'name',
        'kind',
        'baseCurrency',
        'role',
        'createdAt',
        'version',
      ].sort(),
    );
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID);
  });

  it('answers 403 problem+json with code forbidden when the port reports forbidden', async () => {
    const read = vi.fn<WorkspacePort['read']>().mockResolvedValue({
      kind: 'forbidden',
    });
    const application = await createApplication(read);

    const response = await getWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/forbidden',
      title: 'Workspace access forbidden',
      status: 403,
      code: 'forbidden',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID);
  });

  it('answers 404 problem+json with code not-found when the port reports not-found', async () => {
    const read = vi.fn<WorkspacePort['read']>().mockResolvedValue({
      kind: 'not-found',
    });
    const application = await createApplication(read);

    const response = await getWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/not-found',
      title: 'Workspace not found',
      status: 404,
      code: 'not-found',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID);
  });

  it('answers 400 problem+json with code bad-request for a non-UUID workspaceId asserting the port was never called', async () => {
    const read = vi.fn<WorkspacePort['read']>();
    const application = await createApplication(read);

    const response = await getWorkspace(application, 'not-a-uuid', {
      token: TOKEN,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid workspace identifier',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces/not-a-uuid',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with no bearer token', async () => {
    const read = vi.fn<WorkspacePort['read']>();
    const application = await createApplication(read);

    const response = await getWorkspace(application, WORKSPACE_ID);

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
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with an invalid bearer token', async () => {
    const read = vi.fn<WorkspacePort['read']>();
    const application = await createApplication(read);

    const response = await getWorkspace(application, WORKSPACE_ID, {
      token: 'invalid-token',
    });

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
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('GET /v1/workspaces', () => {
  it('answers 200 with items and pageInfo (hasNextPage: false, nextCursor: null) when page is not full and defaults limit to 50', async () => {
    const list = vi.fn<WorkspacePort['list']>().mockResolvedValue({
      items: [WORKSPACE],
      pageInfo: {
        hasNextPage: false,
        nextCursor: null,
      },
    });
    const application = await createApplication(undefined, list);

    const response = await listWorkspaces(application, {}, { token: TOKEN });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.payload)).toEqual({
      items: [WORKSPACE],
      pageInfo: {
        hasNextPage: false,
        nextCursor: null,
      },
    });
    expect(list).toHaveBeenCalledWith(SUBJECT, {
      cursor: undefined,
      limit: 50,
    });
  });

  it('answers 200 with items and pageInfo (hasNextPage: true, nextCursor: string) when hasNextPage is true', async () => {
    const list = vi.fn<WorkspacePort['list']>().mockResolvedValue({
      items: [WORKSPACE],
      pageInfo: {
        hasNextPage: true,
        nextCursor: 'next-page-token',
      },
    });
    const application = await createApplication(undefined, list);

    const response = await listWorkspaces(application, {}, { token: TOKEN });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      items: [WORKSPACE],
      pageInfo: {
        hasNextPage: true,
        nextCursor: 'next-page-token',
      },
    });
  });

  it('passes decoded cursor and custom limit to the port', async () => {
    const list = vi.fn<WorkspacePort['list']>().mockResolvedValue({
      items: [WORKSPACE],
      pageInfo: {
        hasNextPage: false,
        nextCursor: null,
      },
    });
    const application = await createApplication(undefined, list);
    const rawCursor = Buffer.from(
      JSON.stringify(['2026-07-15T00:00:00.000Z', WORKSPACE_ID]),
    ).toString('base64url');

    const response = await listWorkspaces(
      application,
      { cursor: rawCursor, limit: 10 },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(SUBJECT, {
      cursor: {
        createdAt: '2026-07-15T00:00:00.000Z',
        id: WORKSPACE_ID,
      },
      limit: 10,
    });
  });

  it('answers 400 problem+json for malformed cursor with the port never called', async () => {
    const list = vi.fn<WorkspacePort['list']>();
    const application = await createApplication(undefined, list);

    for (const badCursor of [
      'not-base64-!@#$',
      Buffer.from('not-json').toString('base64url'),
      Buffer.from(JSON.stringify({ not: 'an-array' })).toString('base64url'),
      Buffer.from(JSON.stringify(['bad-date', WORKSPACE_ID])).toString(
        'base64url',
      ),
      Buffer.from(
        JSON.stringify(['2026-07-15T00:00:00.000Z', 'bad-uuid']),
      ).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-07-15T00:00:00.000Z'])).toString(
        'base64url',
      ),
    ]) {
      const response = await listWorkspaces(
        application,
        { cursor: badCursor },
        { token: TOKEN },
      );

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(JSON.parse(response.payload)).toEqual({
        type: 'https://savia.app/problems/bad-request',
        title: 'Invalid cursor parameter',
        status: 400,
        code: 'bad-request',
        traceId: expect.stringMatching(/.+/),
        instance: expect.stringContaining('/v1/workspaces'),
      });
    }

    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    '-271821-04-20T00:00:00.000Z',
    '+275760-09-13T00:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '2026-02-30T00:00:00.000Z',
    '2026-07-15T00:00:00Z',
    '2026-07-15T00:00:00.000+02:00',
  ])(
    'answers 400 problem+json for non-canonical or out-of-range cursor timestamp %s with the port never called',
    async (badTimestamp) => {
      const list = vi.fn<WorkspacePort['list']>();
      const application = await createApplication(undefined, list);
      const cursor = Buffer.from(
        JSON.stringify([badTimestamp, WORKSPACE_ID]),
      ).toString('base64url');

      const response = await listWorkspaces(
        application,
        { cursor },
        { token: TOKEN },
      );

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(JSON.parse(response.payload)).toEqual({
        type: 'https://savia.app/problems/bad-request',
        title: 'Invalid cursor parameter',
        status: 400,
        code: 'bad-request',
        traceId: expect.stringMatching(/.+/),
        instance: expect.stringContaining('/v1/workspaces'),
      });
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('positive control: answers 200 and passes canonical in-range cursor to the port', async () => {
    const list = vi.fn<WorkspacePort['list']>().mockResolvedValue({
      items: [WORKSPACE],
      pageInfo: {
        hasNextPage: false,
        nextCursor: null,
      },
    });
    const application = await createApplication(undefined, list);
    const validCursor = Buffer.from(
      JSON.stringify(['2026-07-15T00:00:00.000Z', WORKSPACE_ID]),
    ).toString('base64url');

    const response = await listWorkspaces(
      application,
      { cursor: validCursor },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(SUBJECT, {
      cursor: {
        createdAt: '2026-07-15T00:00:00.000Z',
        id: WORKSPACE_ID,
      },
      limit: 50,
    });
  });

  it.each(['0', '201', 'abc', '-1', '1.5'])(
    'answers 400 problem+json for invalid limit %s with the port never called',
    async (badLimit) => {
      const list = vi.fn<WorkspacePort['list']>();
      const application = await createApplication(undefined, list);

      const response = await listWorkspaces(
        application,
        { limit: badLimit },
        { token: TOKEN },
      );

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(JSON.parse(response.payload)).toEqual({
        type: 'https://savia.app/problems/bad-request',
        title: 'Invalid limit parameter',
        status: 400,
        code: 'bad-request',
        traceId: expect.stringMatching(/.+/),
        instance: expect.stringContaining('/v1/workspaces'),
      });
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('answers 401 problem+json with no bearer token', async () => {
    const list = vi.fn<WorkspacePort['list']>();
    const application = await createApplication(undefined, list);

    const response = await listWorkspaces(application);

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
      instance: '/v1/workspaces',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with an invalid bearer token', async () => {
    const list = vi.fn<WorkspacePort['list']>();
    const application = await createApplication(undefined, list);

    const response = await listWorkspaces(
      application,
      {},
      { token: 'invalid-token' },
    );

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
      instance: '/v1/workspaces',
    });
    expect(list).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/workspaces/:workspaceId', () => {
  it('answers 200 with updated workspace and ETag header on valid update', async () => {
    const updatedWorkspace = {
      ...WORKSPACE,
      name: 'Acme Renovated',
      version: 2,
    };
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'ok',
      workspace: updatedWorkspace,
      version: 2,
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme Renovated' },
      { token: TOKEN, ifMatch: '"1"' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(JSON.parse(response.payload)).toEqual(updatedWorkspace);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Acme Renovated' },
      1,
    );
  });

  it('answers 200 on multi-version If-Match list ("1", "999") when current version is a member', async () => {
    const updatedWorkspace = {
      ...WORKSPACE,
      name: 'Acme Multi Version',
      version: 2,
    };
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'ok',
      workspace: updatedWorkspace,
      version: 2,
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme Multi Version' },
      { token: TOKEN, ifMatch: '"1", "999"' },
    );

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Acme Multi Version' },
      [1, 999],
    );
  });

  it('answers 200 on duplicated If-Match header array when current version is a member', async () => {
    const updatedWorkspace = {
      ...WORKSPACE,
      name: 'Acme Array Header',
      version: 2,
    };
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'ok',
      workspace: updatedWorkspace,
      version: 2,
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme Array Header' },
      { token: TOKEN, ifMatch: ['"1"', '"999"'] },
    );

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Acme Array Header' },
      [1, 999],
    );
  });

  it('answers 200 on If-Match: * for an existing administered workspace (positive control proving * is not ignored)', async () => {
    const updatedWorkspace = {
      ...WORKSPACE,
      name: 'Acme Wildcard Updated',
      version: 2,
    };
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'ok',
      workspace: updatedWorkspace,
      version: 2,
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme Wildcard Updated' },
      { token: TOKEN, ifMatch: '*' },
    );

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Acme Wildcard Updated' },
      undefined,
    );
  });

  it('answers 404 on If-Match: * for an absent workspace as a deliberate deviation from RFC 9110', async () => {
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'not-found',
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme Wildcard Absent' },
      { token: TOKEN, ifMatch: '*' },
    );

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual(
      expect.objectContaining({
        type: 'https://savia.app/problems/not-found',
        status: 404,
        code: 'not-found',
      }),
    );
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      { name: 'Acme Wildcard Absent' },
      undefined,
    );
  });

  it('answers 422 for empty update {} and does not call port', async () => {
    const update = vi.fn<WorkspacePort['update']>();
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual(
      expect.objectContaining({
        type: 'https://savia.app/problems/unprocessable',
        status: 422,
        code: 'unprocessable',
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 422 for unknown fields and does not call port', async () => {
    const update = vi.fn<WorkspacePort['update']>();
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme', unknownProperty: 'value' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 422 for immutable field kind and does not call port', async () => {
    const update = vi.fn<WorkspacePort['update']>();
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { kind: 'family' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 422 for invalid baseCurrency (USDX, US) and proves port was never called', async () => {
    for (const invalidCurrency of ['USDX', 'US', 'usd1', 'XXZ']) {
      const update = vi.fn<WorkspacePort['update']>();
      const application = await createApplication(undefined, undefined, update);

      const response = await patchWorkspace(
        application,
        WORKSPACE_ID,
        { baseCurrency: invalidCurrency },
        { token: TOKEN },
      );

      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('answers 412 for malformed If-Match and does not call port', async () => {
    for (const malformed of ['007', '"007"', 'W/"1"', 'invalid', '""']) {
      const update = vi.fn<WorkspacePort['update']>();
      const application = await createApplication(undefined, undefined, update);

      const response = await patchWorkspace(
        application,
        WORKSPACE_ID,
        { name: 'Acme' },
        { token: TOKEN, ifMatch: malformed },
      );

      expect(response.statusCode).toBe(412);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('answers 412 (not 500) for oversized If-Match values', async () => {
    for (const oversized of ['"2147483648"', '"100000000000000000000"']) {
      const update = vi.fn<WorkspacePort['update']>();
      const application = await createApplication(undefined, undefined, update);

      const response = await patchWorkspace(
        application,
        WORKSPACE_ID,
        { name: 'Acme' },
        { token: TOKEN, ifMatch: oversized },
      );

      expect(response.statusCode).toBe(412);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('answers 400 problem+json when workspaceId is not a valid UUID', async () => {
    const update = vi.fn<WorkspacePort['update']>();
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      'not-a-uuid',
      { name: 'Acme' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid workspace identifier',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces/not-a-uuid',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with no bearer token', async () => {
    const update = vi.fn<WorkspacePort['update']>();
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(application, WORKSPACE_ID, {
      name: 'Acme',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when port returns forbidden', async () => {
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'forbidden',
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/forbidden',
      title: 'Workspace access forbidden',
      status: 403,
      code: 'forbidden',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 404 problem+json when port returns not-found', async () => {
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'not-found',
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme' },
      { token: TOKEN },
    );

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/not-found',
      title: 'Workspace not found',
      status: 404,
      code: 'not-found',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 412 problem+json when port returns version-conflict', async () => {
    const update = vi.fn<WorkspacePort['update']>().mockResolvedValue({
      kind: 'version-conflict',
    });
    const application = await createApplication(undefined, undefined, update);

    const response = await patchWorkspace(
      application,
      WORKSPACE_ID,
      { name: 'Acme' },
      { token: TOKEN, ifMatch: '"1"' },
    );

    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/precondition-failed',
      title: 'Precondition failed',
      status: 412,
      code: 'precondition-failed',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });
});

describe('DELETE /v1/workspaces/:workspaceId', () => {
  it('answers 204 on valid deletion and passes subject, workspaceId, and idempotencyKey to the port', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'deleted',
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(deleteOp).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      IDEMPOTENCY_KEY,
    );
  });

  it('answers 204 on replayed outcome (status 204)', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'replayed',
      status: 204,
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(deleteOp).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      IDEMPOTENCY_KEY,
    );
  });

  it('answers 403 on replayed refusal (status 403) with freshly rendered ProblemDetails', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'replayed',
      status: 403,
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/forbidden',
      title: 'Workspace access forbidden',
      status: 403,
      code: 'forbidden',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 404 on replayed refusal (status 404) with freshly rendered ProblemDetails', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'replayed',
      status: 404,
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/not-found',
      title: 'Workspace not found',
      status: 404,
      code: 'not-found',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 422 on replayed refusal (status 422) with freshly rendered ProblemDetails', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'replayed',
      status: 422,
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/unprocessable',
      title: 'Unprocessable entity',
      status: 422,
      code: 'unprocessable',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 409 problem+json when the port reports an idempotency conflict', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'idempotency-conflict',
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/conflict',
      title: 'Idempotency conflict',
      status: 409,
      code: 'conflict',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 403 problem+json when port returns forbidden', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'forbidden',
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/forbidden',
      title: 'Workspace access forbidden',
      status: 403,
      code: 'forbidden',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 404 problem+json when port returns not-found', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'not-found',
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/not-found',
      title: 'Workspace not found',
      status: 404,
      code: 'not-found',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 422 problem+json when port returns unprocessable', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>().mockResolvedValue({
      kind: 'unprocessable',
    });
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/unprocessable',
      title: 'Unprocessable entity',
      status: 422,
      code: 'unprocessable',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
    });
  });

  it('answers 400 problem+json for missing Idempotency-Key header and asserts port was never called', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid Idempotency-Key header',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
      detail: expect.any(String),
    });
    expect(deleteOp).not.toHaveBeenCalled();
  });

  it('answers 400 problem+json for duplicated Idempotency-Key header (array) and asserts port was never called', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: [
        '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01',
        '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb02',
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid Idempotency-Key header',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
      detail: expect.any(String),
    });
    expect(deleteOp).not.toHaveBeenCalled();
  });

  it('answers 400 problem+json for non-UUID Idempotency-Key header and asserts port was never called', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: TOKEN,
      idempotencyKey: 'not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid Idempotency-Key header',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: `/v1/workspaces/${WORKSPACE_ID}`,
      detail: expect.any(String),
    });
    expect(deleteOp).not.toHaveBeenCalled();
  });

  it('answers 400 problem+json for non-UUID workspaceId and asserts port was never called', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, 'not-a-uuid', {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(JSON.parse(response.payload)).toEqual({
      type: 'https://savia.app/problems/bad-request',
      title: 'Invalid workspace identifier',
      status: 400,
      code: 'bad-request',
      traceId: expect.stringMatching(/.+/),
      instance: '/v1/workspaces/not-a-uuid',
    });
    expect(deleteOp).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with no bearer token', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(deleteOp).not.toHaveBeenCalled();
  });

  it('answers 401 problem+json with an invalid bearer token', async () => {
    const deleteOp = vi.fn<WorkspacePort['delete']>();
    const application = await createApplication(
      undefined,
      undefined,
      undefined,
      undefined,
      deleteOp,
    );

    const response = await deleteWorkspace(application, WORKSPACE_ID, {
      token: 'invalid-token',
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(deleteOp).not.toHaveBeenCalled();
  });
});

describe('GET /v1/workspaces/:workspaceId wiring', () => {
  it('resolves WORKSPACE_PORT to the real WorkspaceService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue(verifier)
      .compile();
    expect(moduleRef.get(WORKSPACE_PORT)).toBeInstanceOf(WorkspaceService);
    await moduleRef.close();
  });
});
