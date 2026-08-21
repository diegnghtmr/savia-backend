import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import {
  WORKSPACE_PORT,
  type Workspace,
  type WorkspaceAccess,
  type WorkspacePort,
} from '../src/identity/workspace.port.js';
import { WorkspaceService } from '../src/identity/workspace.service.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';

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
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(WORKSPACE_PORT)
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
