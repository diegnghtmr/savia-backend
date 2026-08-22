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
  encodeMemberCursor,
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  WORKSPACE_MEMBER_PORT,
  type WorkspaceMember,
  type WorkspaceMemberListOutcome,
  type WorkspaceMemberPort,
} from '../src/identity/workspace-member.port.js';
import {
  WORKSPACE_PORT,
  type WorkspacePort,
} from '../src/identity/workspace.port.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';

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

const defaultMember: WorkspaceMember = {
  id: '00000000-0000-0000-0000-000000000001',
  userId: SUBJECT,
  displayName: 'Active User',
  role: 'owner',
  status: 'active',
  joinedAt: '2026-07-15T00:00:00.000Z',
};

async function createApplication(
  listWorkspaceMembers: WorkspaceMemberPort['listWorkspaceMembers'] = vi
    .fn()
    .mockResolvedValue({
      kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
      page: {
        items: [defaultMember],
        pageInfo: {
          hasNextPage: false,
          nextCursor: null,
        },
      },
    } satisfies WorkspaceMemberListOutcome),
): Promise<NestFastifyApplication> {
  const dummyWorkspacePort: WorkspacePort = {
    read: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(WORKSPACE_PORT)
    .useValue(dummyWorkspacePort)
    .overrideProvider(WORKSPACE_MEMBER_PORT)
    .useValue({ listWorkspaceMembers })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function listWorkspaceMembersRequest(
  application: NestFastifyApplication,
  workspaceId: string,
  query: { cursor?: string; limit?: number | string } | string = {},
  options: { token?: string } = {},
) {
  let url = `/v1/workspaces/${workspaceId}/members`;
  if (typeof query === 'string') {
    url += query.startsWith('?') ? query : `?${query}`;
  } else {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const queryString = params.toString();
    if (queryString) url += `?${queryString}`;
  }
  return application.inject({
    method: 'GET',
    url,
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
  });
}

describe('listWorkspaceMembers HTTP boundary', () => {
  it('returns 200 with items and pageInfo for an active member', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([defaultMember]);
    expect(body.pageInfo).toEqual({
      hasNextPage: false,
      nextCursor: null,
    });
  });

  it('returns 401 when no bearer token is presented', async () => {
    const listSpy = vi.fn();
    const appInstance = await createApplication(listSpy);
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
    );
    expect(response.statusCode).toBe(401);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller membership is suspended', async () => {
    const appInstance = await createApplication(
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.FORBIDDEN,
      }),
    );
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/forbidden');
    expect(body.code).toBe('forbidden');
  });

  it('returns 404 when the caller has no membership in the workspace', async () => {
    const appInstance = await createApplication(
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.NOT_FOUND,
      }),
    );
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/not-found');
    expect(body.code).toBe('not-found');
  });

  it('returns 400 for a malformed cursor and never 500', async () => {
    const appInstance = await createApplication();

    const badCursor1 = '%%%not-base64%%%';
    const response1 = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      `cursor=${badCursor1}`,
      { token: TOKEN },
    );
    expect(response1.statusCode).toBe(400);
    expect(response1.statusCode).not.toBe(500);
    const body1 = response1.json();
    expect(body1.type).toBe('https://savia.app/problems/bad-request');
    expect(body1.code).toBe('bad-request');

    const outOfRange = Buffer.from(
      JSON.stringify([
        '+275760-09-13T00:00:00.000Z',
        '00000000-0000-0000-0000-000000000001',
      ]),
    ).toString('base64url');
    const response2 = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor: outOfRange },
      { token: TOKEN },
    );
    expect(response2.statusCode).toBe(400);
    expect(response2.statusCode).not.toBe(500);
    const body2 = response2.json();
    expect(body2.type).toBe('https://savia.app/problems/bad-request');
    expect(body2.code).toBe('bad-request');
  });

  it('returns 400 for a non-numeric limit', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { limit: 'abc' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/bad-request');
    expect(body.code).toBe('bad-request');
  });

  it('returns 400 for a limit outside 1..200', async () => {
    const appInstance = await createApplication();
    const responseZero = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { limit: 0 },
      { token: TOKEN },
    );
    expect(responseZero.statusCode).toBe(400);
    expect(responseZero.json().code).toBe('bad-request');

    const responseOver = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { limit: 201 },
      { token: TOKEN },
    );
    expect(responseOver.statusCode).toBe(400);
    expect(responseOver.json().code).toBe('bad-request');
  });

  it('returns 400 for a workspace identifier that is not a UUID', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceMembersRequest(
      appInstance,
      'not-a-uuid',
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('bad-request');
  });

  it('passes the decoded cursor and limit through to the port', async () => {
    const listSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
      page: {
        items: [],
        pageInfo: {
          hasNextPage: false,
          nextCursor: null,
        },
      },
    });
    const appInstance = await createApplication(listSpy);
    const rawCursor = encodeMemberCursor({
      joinedAt: '2026-07-15T00:00:00.000Z',
      membershipId: '00000000-0000-0000-0000-000000000001',
    });

    await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor: rawCursor, limit: 25 },
      { token: TOKEN },
    );
    expect(listSpy).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, {
      cursor: {
        joinedAt: '2026-07-15T00:00:00.000Z',
        membershipId: '00000000-0000-0000-0000-000000000001',
      },
      limit: 25,
    });

    listSpy.mockClear();
    await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(listSpy).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, {
      cursor: undefined,
      limit: 50,
    });
  });

  it('omits email from every item when the port returns no email', async () => {
    const itemWithoutEmail: WorkspaceMember = {
      id: '00000000-0000-0000-0000-000000000002',
      userId: '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3e',
      displayName: 'Editor User',
      role: 'editor',
      status: 'active',
      joinedAt: '2026-07-15T00:00:00.000Z',
    };
    const appInstance = await createApplication(
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
        page: {
          items: [itemWithoutEmail],
          pageInfo: {
            hasNextPage: false,
            nextCursor: null,
          },
        },
      }),
    );
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.length).toBe(1);
    expect(Object.hasOwn(body.items[0], 'email')).toBe(false);
    expect('email' in body.items[0]).toBe(false);
  });

  it('never exposes privacyModeEnabled, defaultCurrency or locale in the response body', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('privacyModeEnabled');
    expect(response.body).not.toContain('defaultCurrency');
    expect(response.body).not.toContain('locale');
    const body = response.json();
    for (const item of body.items) {
      const keys = Object.keys(item);
      expect(
        keys.every((k) =>
          [
            'id',
            'userId',
            'displayName',
            'email',
            'role',
            'status',
            'joinedAt',
          ].includes(k),
        ),
      ).toBe(true);
    }
  });

  it('returns the nextCursor and hasNextPage supplied by the port', async () => {
    const appInstance = await createApplication(
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
        page: {
          items: [defaultMember],
          pageInfo: {
            hasNextPage: true,
            nextCursor: 'next-cursor-test-value',
          },
        },
      }),
    );
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pageInfo).toEqual({
      hasNextPage: true,
      nextCursor: 'next-cursor-test-value',
    });
  });
});
