import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../src/platform/problem-details.js';
import { encodeCursor } from '../src/platform/cursor.js';
import {
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  WORKSPACE_MEMBER_PORT,
  WORKSPACE_MEMBER_REMOVE_OUTCOMES,
  WORKSPACE_MEMBER_UPDATE_OUTCOMES,
  type WorkspaceMember,
  type WorkspaceMemberListOutcome,
  type WorkspaceMemberPort,
  type WorkspaceMemberRemoveOutcome,
  type WorkspaceMemberUpdateOutcome,
} from '../src/identity/workspace-member.port.js';
import {
  WORKSPACE_PORT,
  type WorkspacePort,
} from '../src/identity/workspace.port.js';
import { IDENTITY_PROBLEM_TYPES } from '../src/identity/identity-problem-types.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
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
  email: 'active@example.test',
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
  updateWorkspaceMember: WorkspaceMemberPort['updateWorkspaceMember'] = vi
    .fn()
    .mockResolvedValue({
      kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK,
      member: defaultMember,
      version: 2,
    } satisfies WorkspaceMemberUpdateOutcome),
  removeWorkspaceMember: WorkspaceMemberPort['removeWorkspaceMember'] = vi
    .fn()
    .mockResolvedValue({
      kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED,
    } satisfies WorkspaceMemberRemoveOutcome),
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
    .useValue({
      listWorkspaceMembers,
      updateWorkspaceMember,
      removeWorkspaceMember,
    })
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

function updateWorkspaceMemberRequest(
  application: NestFastifyApplication,
  workspaceId: string,
  memberId: string,
  body: unknown = { role: 'editor' },
  options: { token?: string; ifMatch?: string } = {},
) {
  return application.inject({
    method: 'PATCH',
    url: `/v1/workspaces/${workspaceId}/members/${memberId}`,
    payload: body as Record<string, unknown>,
    headers: {
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
    },
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

  it('returns 400 for a cursor with non-base64 payload and never 500', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      'cursor=%%%not-base64%%%',
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/bad-request');
    expect(body.code).toBe('bad-request');
  });

  it('returns 400 for a cursor containing a NUL byte and never 500', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      'cursor=abc%00def',
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    expect(response.json().code).toBe('bad-request');
  });

  it('returns 400 for a cursor with year-0000 timestamp and never 500', async () => {
    const appInstance = await createApplication();
    const cursor = Buffer.from(
      JSON.stringify([
        WORKSPACE_ID,
        '0000-01-01T00:00:00.000Z',
        '00000000-0000-0000-0000-000000000001',
      ]),
    ).toString('base64url');
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    expect(response.json().code).toBe('bad-request');
  });

  it('returns 400 for a cursor with an extended-year timestamp and never 500', async () => {
    const appInstance = await createApplication();
    const cursor = Buffer.from(
      JSON.stringify([
        WORKSPACE_ID,
        '+275760-09-13T00:00:00.000Z',
        '00000000-0000-0000-0000-000000000001',
      ]),
    ).toString('base64url');
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    expect(response.json().code).toBe('bad-request');
  });

  it('returns 400 for a cursor minted for another workspace (foreign workspace) and never 500', async () => {
    const appInstance = await createApplication();
    const foreignWorkspaceId = '00000000-0000-0000-0000-000000000099';
    const cursor = encodeCursor({
      workspaceId: foreignWorkspaceId,
      createdAt: '2026-07-15T00:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    expect(response.json().code).toBe('bad-request');
  });

  it('returns 400 for an over-long cursor exceeding max length and never 500', async () => {
    const appInstance = await createApplication();
    const validCursor = encodeCursor({
      workspaceId: WORKSPACE_ID,
      createdAt: '2026-07-15T00:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });
    const overlongCursor = validCursor + 'A'.repeat(300);
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor: overlongCursor },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    expect(response.json().code).toBe('bad-request');
  });

  it('returns 400 for a cursor with non-canonical trailing whitespace and never 500', async () => {
    const appInstance = await createApplication();
    const nonCanonical = Buffer.from(
      JSON.stringify([
        WORKSPACE_ID,
        '2026-07-15T00:00:00.000Z',
        '00000000-0000-0000-0000-000000000001',
      ]) + '   ',
    ).toString('base64url');
    const response = await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor: nonCanonical },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
    expect(response.json().code).toBe('bad-request');
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
    const rawCursor = encodeCursor({
      workspaceId: WORKSPACE_ID,
      createdAt: '2026-07-15T00:00:00.000000Z',
      id: '00000000-0000-0000-0000-000000000001',
    });

    await listWorkspaceMembersRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor: rawCursor, limit: 25 },
      { token: TOKEN },
    );
    expect(listSpy).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, {
      cursor: {
        workspaceId: WORKSPACE_ID,
        createdAt: '2026-07-15T00:00:00.000000Z',
        id: '00000000-0000-0000-0000-000000000001',
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

  it('includes email when the port returns an email (positive control)', async () => {
    const itemWithEmail: WorkspaceMember = {
      id: '00000000-0000-0000-0000-000000000001',
      userId: SUBJECT,
      displayName: 'Active User',
      email: 'active@example.test',
      role: 'owner',
      status: 'active',
      joinedAt: '2026-07-15T00:00:00.000Z',
    };
    const appInstance = await createApplication(
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_LIST_OUTCOMES.OK,
        page: {
          items: [itemWithEmail],
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
    expect(body.items[0].email).toBe('active@example.test');
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

describe('updateWorkspaceMember HTTP boundary', () => {
  it('returns 200 with updated member body and ETag header on OK outcome', async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK,
      member: {
        ...defaultMember,
        role: 'editor',
      },
      version: 5,
    });
    const appInstance = await createApplication(undefined, updateSpy);
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"5"');
    const body = response.json();
    expect(body.id).toBe(defaultMember.id);
    expect(body.role).toBe('editor');
    expect(Object.hasOwn(body, 'version')).toBe(false);
  });

  it('returns 401 when no bearer token is presented', async () => {
    const updateSpy = vi.fn();
    const appInstance = await createApplication(undefined, updateSpy);
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
    );
    expect(response.statusCode).toBe(401);
    expect(updateSpy).not.toHaveBeenCalled();
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/unauthorized');
    expect(body.code).toBe('unauthorized');
  });

  it('returns 400 for a workspace identifier that is not a UUID', async () => {
    const appInstance = await createApplication();
    for (const badWs of [
      'not-a-uuid',
      `workspace\0${WORKSPACE_ID}`,
      'a'.repeat(80),
    ]) {
      const response = await updateWorkspaceMemberRequest(
        appInstance,
        badWs,
        MEMBER_ID,
        { role: 'editor' },
        { token: TOKEN },
      );
      expect(response.statusCode).toBe(400);
      expect(response.statusCode).not.toBe(500);
      expect(response.json().type).toBe(
        'https://savia.app/problems/bad-request',
      );
      expect(response.json().code).toBe('bad-request');
    }
    const overlong = await updateWorkspaceMemberRequest(
      appInstance,
      'a'.repeat(10_000),
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(overlong.statusCode).toBeGreaterThanOrEqual(400);
    expect(overlong.statusCode).toBeLessThan(500);
    expect(overlong.statusCode).not.toBe(500);
  });

  it('returns 400 for a member identifier that is not a UUID', async () => {
    const appInstance = await createApplication();
    for (const badMem of [
      'not-a-uuid',
      `member\0${MEMBER_ID}`,
      'b'.repeat(80),
    ]) {
      const response = await updateWorkspaceMemberRequest(
        appInstance,
        WORKSPACE_ID,
        badMem,
        { role: 'editor' },
        { token: TOKEN },
      );
      expect(response.statusCode).toBe(400);
      expect(response.statusCode).not.toBe(500);
      expect(response.json().type).toBe(
        'https://savia.app/problems/bad-request',
      );
      expect(response.json().code).toBe('bad-request');
    }
    const overlong = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      'b'.repeat(10_000),
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(overlong.statusCode).toBeGreaterThanOrEqual(400);
    expect(overlong.statusCode).toBeLessThan(500);
    expect(overlong.statusCode).not.toBe(500);
  });

  it('returns 403 when outcome is FORBIDDEN', async () => {
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/forbidden');
    expect(body.code).toBe('forbidden');
  });

  it('returns 404 when outcome is NOT_FOUND', async () => {
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/not-found');
    expect(body.code).toBe('not-found');
  });

  it('returns 409 when outcome is PERSONAL_WORKSPACE with personal-workspace-membership problem type', async () => {
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.PERSONAL_WORKSPACE,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(
      'https://savia.app/problems/personal-workspace-membership',
    );
    expect(body.code).toBe('personal-workspace-membership');
  });

  it('returns 409 when outcome is LAST_OWNER_REQUIRED with last-owner-required problem type', async () => {
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/last-owner-required');
    expect(body.code).toBe('last-owner-required');
  });

  it('returns 409 when outcome is CONFLICT with conflict problem type', async () => {
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.CONFLICT,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/conflict');
    expect(body.code).toBe('conflict');
  });

  it('returns 412 when outcome is VERSION_CONFLICT with precondition-failed problem type', async () => {
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN, ifMatch: '"1"' },
    );
    expect(response.statusCode).toBe(412);
    const body = response.json();
    expect(body.type).toBe('https://savia.app/problems/precondition-failed');
    expect(body.code).toBe('precondition-failed');
  });

  it('returns 412 when an over-large ETag or malformed If-Match is refused and never 500', async () => {
    const appInstance = await createApplication();
    for (const badIfMatch of [
      'W/"7"',
      '"007"',
      '7',
      '""',
      '"99999999999999999999"',
      '"7\0"',
      '\0',
    ]) {
      const response = await updateWorkspaceMemberRequest(
        appInstance,
        WORKSPACE_ID,
        MEMBER_ID,
        { role: 'editor' },
        { token: TOKEN, ifMatch: badIfMatch },
      );
      expect(response.statusCode).toBe(412);
      expect(response.statusCode).not.toBe(500);
      const body = response.json();
      expect(body.type).toBe('https://savia.app/problems/precondition-failed');
      expect(body.code).toBe('precondition-failed');
    }
  });

  it('returns 422 for invalid request body', async () => {
    const appInstance = await createApplication();
    for (const badBody of [
      {},
      { role: 'admin' },
      { role: 'OWNER' },
      { role: 'editor', status: 'suspended' },
      { role: null },
      { role: 42 },
      { role: 'editor\0' },
      { role: 'a'.repeat(10_000) },
      [],
    ]) {
      const response = await updateWorkspaceMemberRequest(
        appInstance,
        WORKSPACE_ID,
        MEMBER_ID,
        badBody,
        { token: TOKEN },
      );
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe('https://savia.app/problems/unprocessable');
      expect(body.code).toBe('unprocessable');
      expect(body.errors).toBeDefined();
    }
  });

  it('passes parsed If-Match version to the port', async () => {
    const updateSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK,
      member: defaultMember,
      version: 8,
    });
    const appInstance = await createApplication(undefined, updateSpy);

    // Single version
    await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN, ifMatch: '"7"' },
    );
    expect(updateSpy).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      7,
    );

    updateSpy.mockClear();
    // Multi version list
    await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN, ifMatch: '"1", "7"' },
    );
    expect(updateSpy).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      [1, 7],
    );

    updateSpy.mockClear();
    // Any (*)
    await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN, ifMatch: '*' },
    );
    expect(updateSpy).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      undefined,
    );

    updateSpy.mockClear();
    // Absent
    await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(updateSpy).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      undefined,
    );
  });

  it('includes email when the port returns a member with email (positive control)', async () => {
    const memberWithEmail: WorkspaceMember = {
      id: MEMBER_ID,
      userId: SUBJECT,
      displayName: 'Active User',
      email: 'user@example.test',
      role: 'editor',
      status: 'active',
      joinedAt: '2026-07-15T00:00:00.000Z',
    };
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK,
        member: memberWithEmail,
        version: 2,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.email).toBe('user@example.test');
    expect(Object.hasOwn(body, 'email')).toBe(true);
  });

  it('omits email when the port returns a member without email', async () => {
    const memberWithoutEmail: WorkspaceMember = {
      id: MEMBER_ID,
      userId: SUBJECT,
      displayName: 'Active User',
      role: 'editor',
      status: 'active',
      joinedAt: '2026-07-15T00:00:00.000Z',
    };
    const appInstance = await createApplication(
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK,
        member: memberWithoutEmail,
        version: 2,
      }),
    );
    const response = await updateWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.hasOwn(body, 'email')).toBe(false);
  });
});

function removeWorkspaceMemberRequest(
  appInstance: NestFastifyApplication,
  workspaceId: string,
  memberId: string,
  options: {
    token?: string;
    idempotencyKey?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  return appInstance.inject({
    method: 'DELETE',
    url: `/v1/workspaces/${workspaceId}/members/${memberId}`,
    headers,
  });
}

describe('removeWorkspaceMember HTTP boundary', () => {
  it('returns 204 No Content with empty body on successful removal', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REMOVED,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('rejects missing, malformed, NUL byte, and overlong Idempotency-Key headers with 400 bad-request', async () => {
    const appInstance = await createApplication();

    const missingKey = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN },
    );
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
    expect(missingKey.json().code).toBe('bad-request');

    const nonUuid = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: 'not-a-uuid' },
    );
    expect(nonUuid.statusCode).toBe(400);
    expect(nonUuid.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
    expect(nonUuid.json().code).toBe('bad-request');

    const nulByte = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: `${IDEMPOTENCY_KEY}\0extra` },
    );
    expect(nulByte.statusCode).toBe(400);
    expect(nulByte.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
    expect(nulByte.json().code).toBe('bad-request');

    const overlong = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: 'a'.repeat(256) },
    );
    expect(overlong.statusCode).toBe(400);
    expect(overlong.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
    expect(overlong.json().code).toBe('bad-request');
  });

  it('rejects invalid workspaceId or memberId with 400 bad-request', async () => {
    const appInstance = await createApplication();

    for (const badWs of [
      'invalid-ws-id',
      `workspace\0${WORKSPACE_ID}`,
      'a'.repeat(80),
    ]) {
      const badWsRes = await removeWorkspaceMemberRequest(
        appInstance,
        badWs,
        MEMBER_ID,
        { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
      );
      expect(badWsRes.statusCode).toBe(400);
      expect(badWsRes.statusCode).not.toBe(500);
      expect(badWsRes.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(badWsRes.json().code).toBe('bad-request');
    }
    const overlongWs = await removeWorkspaceMemberRequest(
      appInstance,
      'a'.repeat(10_000),
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(overlongWs.statusCode).toBeGreaterThanOrEqual(400);
    expect(overlongWs.statusCode).toBeLessThan(500);
    expect(overlongWs.statusCode).not.toBe(500);

    for (const badMem of [
      'invalid-member-id',
      `member\0${MEMBER_ID}`,
      'b'.repeat(80),
    ]) {
      const badMemberRes = await removeWorkspaceMemberRequest(
        appInstance,
        WORKSPACE_ID,
        badMem,
        { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
      );
      expect(badMemberRes.statusCode).toBe(400);
      expect(badMemberRes.statusCode).not.toBe(500);
      expect(badMemberRes.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(badMemberRes.json().code).toBe('bad-request');
    }
    const overlongMem = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      'b'.repeat(10_000),
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(overlongMem.statusCode).toBeGreaterThanOrEqual(400);
    expect(overlongMem.statusCode).toBeLessThan(500);
    expect(overlongMem.statusCode).not.toBe(500);
  });

  it('rejects unauthenticated requests with 401 unauthorized', async () => {
    const appInstance = await createApplication();
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().type).toBe(PROBLEM_TYPES.UNAUTHORIZED);
    expect(response.json().code).toBe('unauthorized');
  });

  it('maps forbidden outcome to 403 problem details', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.FORBIDDEN,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
    expect(response.json().code).toBe('forbidden');
  });

  it('maps not-found outcome to 404 problem details', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.NOT_FOUND,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
    expect(response.json().code).toBe('not-found');
  });

  it('maps personal-workspace outcome to 409 personal-workspace-membership problem details', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.PERSONAL_WORKSPACE,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe(
      IDENTITY_PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
    );
    expect(response.json().code).toBe('personal-workspace-membership');
  });

  it('maps last-owner-required outcome to 409 last-owner-required problem details', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe(
      IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED,
    );
    expect(response.json().code).toBe('last-owner-required');
  });

  it('maps idempotency-conflict outcome to 409 conflict problem details', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe(PROBLEM_TYPES.CONFLICT);
    expect(response.json().code).toBe('conflict');
  });

  it('replays 204 No Content with empty body', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED,
        status: 204,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('replays 403 forbidden refusal', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED,
        status: 403,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
    expect(response.json().code).toBe('forbidden');
  });

  it('replays 404 not-found refusal', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED,
        status: 404,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
    expect(response.json().code).toBe('not-found');
  });

  it('replays 409 personal-workspace-membership refusal', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED,
        status: 409,
        problemType: IDENTITY_PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe(
      IDENTITY_PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
    );
    expect(response.json().code).toBe('personal-workspace-membership');
  });

  it('replays 409 last-owner-required refusal', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED,
        status: 409,
        problemType: IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe(
      IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED,
    );
    expect(response.json().code).toBe('last-owner-required');
  });

  it('replays 409 conflict refusal', async () => {
    const appInstance = await createApplication(
      undefined,
      undefined,
      vi.fn().mockResolvedValue({
        kind: WORKSPACE_MEMBER_REMOVE_OUTCOMES.REPLAYED,
        status: 409,
      }),
    );
    const response = await removeWorkspaceMemberRequest(
      appInstance,
      WORKSPACE_ID,
      MEMBER_ID,
      { token: TOKEN, idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe(PROBLEM_TYPES.CONFLICT);
    expect(response.json().code).toBe('conflict');
  });
});
