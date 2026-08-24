import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityModule } from '../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../src/identity/problem-details.js';
import {
  WORKSPACE_INVITATION_CREATE_OUTCOMES,
  WORKSPACE_INVITATION_LIST_OUTCOMES,
  WORKSPACE_INVITATION_PORT,
  type WorkspaceInvitation,
  type WorkspaceInvitationCreateOutcome,
  type WorkspaceInvitationListOutcome,
  type WorkspaceInvitationPort,
} from '../src/identity/workspace-invitation.port.js';
import {
  WORKSPACE_MEMBER_PORT,
  type WorkspaceMemberPort,
} from '../src/identity/workspace-member.port.js';
import {
  WORKSPACE_PORT,
  type WorkspacePort,
} from '../src/identity/workspace.port.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = '00000000-0000-0000-0000-000000000001';
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

const defaultInvitation: WorkspaceInvitation = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'invitee@example.test',
  role: 'editor',
  status: 'pending',
  expiresAt: '2026-07-22T00:00:00.000Z',
  createdAt: '2026-07-15T00:00:00.000Z',
};

async function createApplication(
  listWorkspaceInvitations: WorkspaceInvitationPort['listWorkspaceInvitations'] = vi
    .fn()
    .mockResolvedValue({
      kind: WORKSPACE_INVITATION_LIST_OUTCOMES.OK,
      page: {
        items: [defaultInvitation],
        pageInfo: {
          hasNextPage: false,
          nextCursor: null,
        },
      },
    } satisfies WorkspaceInvitationListOutcome),
  createWorkspaceInvitation: WorkspaceInvitationPort['createWorkspaceInvitation'] = vi
    .fn()
    .mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED,
      invitation: defaultInvitation,
    } satisfies WorkspaceInvitationCreateOutcome),
): Promise<NestFastifyApplication> {
  const dummyWorkspacePort: WorkspacePort = {
    read: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  const dummyMemberPort: WorkspaceMemberPort = {
    listWorkspaceMembers: vi.fn(),
    updateWorkspaceMember: vi.fn(),
    removeWorkspaceMember: vi.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(WORKSPACE_PORT)
    .useValue(dummyWorkspacePort)
    .overrideProvider(WORKSPACE_MEMBER_PORT)
    .useValue(dummyMemberPort)
    .overrideProvider(WORKSPACE_INVITATION_PORT)
    .useValue({ listWorkspaceInvitations, createWorkspaceInvitation })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function listWorkspaceInvitationsRequest(
  application: NestFastifyApplication,
  workspaceId: string,
  query: { cursor?: string; limit?: number | string } | string = {},
  options: { token?: string } = {},
) {
  let url = `/v1/workspaces/${workspaceId}/invitations`;
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

function createWorkspaceInvitationRequest(
  application: NestFastifyApplication,
  workspaceId: string,
  body: unknown = { email: 'invitee@example.test', role: 'editor' },
  options: { token?: string; idempotencyKey?: string } = {},
) {
  return application.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/invitations`,
    payload: body as Record<string, unknown>,
    headers: {
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(options.idempotencyKey === undefined
        ? { 'idempotency-key': IDEMPOTENCY_KEY }
        : options.idempotencyKey === ''
          ? {}
          : { 'idempotency-key': options.idempotencyKey }),
    },
  });
}

describe('listWorkspaceInvitations HTTP boundary', () => {
  it('returns 200 with items and pageInfo for owner/admin', async () => {
    const appInstance = await createApplication();
    const response = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([defaultInvitation]);
    expect(body.pageInfo).toEqual({
      hasNextPage: false,
      nextCursor: null,
    });
  });

  it('returns 401 when no bearer token is presented', async () => {
    const listSpy = vi.fn();
    const appInstance = await createApplication(listSpy);
    const response = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      {},
    );
    expect(response.statusCode).toBe(401);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is an editor or viewer', async () => {
    const listSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_LIST_OUTCOMES.FORBIDDEN,
    });
    const appInstance = await createApplication(listSpy);
    const response = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
  });

  it('returns 404 when the caller is not a member of the workspace', async () => {
    const listSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_LIST_OUTCOMES.NOT_FOUND,
    });
    const appInstance = await createApplication(listSpy);
    const response = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
  });

  it('returns 400 when workspaceId is not a valid UUID', async () => {
    const listSpy = vi.fn();
    const appInstance = await createApplication(listSpy);
    const response = await listWorkspaceInvitationsRequest(
      appInstance,
      'invalid-uuid',
      {},
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when cursor parameter is malformed', async () => {
    const listSpy = vi.fn();
    const appInstance = await createApplication(listSpy);
    const response = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      { cursor: 'not-valid-base64-json' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.BAD_REQUEST);
    expect(body.code).toBe('bad-request');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when limit parameter is out of range or not a number', async () => {
    const listSpy = vi.fn();
    const appInstance = await createApplication(listSpy);

    // limit = 0
    const res0 = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      { limit: 0 },
      { token: TOKEN },
    );
    expect(res0.statusCode).toBe(400);

    // limit = 201
    const res201 = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      { limit: 201 },
      { token: TOKEN },
    );
    expect(res201.statusCode).toBe(400);

    // limit = not a number
    const resAbc = await listWorkspaceInvitationsRequest(
      appInstance,
      WORKSPACE_ID,
      { limit: 'abc' },
      { token: TOKEN },
    );
    expect(resAbc.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('createWorkspaceInvitation HTTP boundary', () => {
  it('returns 201 when owner creates an editor invitation', async () => {
    const appInstance = await createApplication();
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual(defaultInvitation);
  });

  it('returns 201 for positive control: owner invites at role owner (RULING 23)', async () => {
    const ownerInv: WorkspaceInvitation = {
      ...defaultInvitation,
      role: 'owner',
    };
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED,
      invitation: ownerInv,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'newowner@example.test', role: 'owner' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().role).toBe('owner');
  });

  it('returns 401 when no bearer token is presented', async () => {
    const createSpy = vi.fn();
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
    );
    expect(response.statusCode).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when Idempotency-Key header is missing or malformed', async () => {
    const createSpy = vi.fn();
    const appInstance = await createApplication(undefined, createSpy);

    // Missing
    const resMissing = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN, idempotencyKey: '' },
    );
    expect(resMissing.statusCode).toBe(400);

    // Malformed
    const resMalformed = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN, idempotencyKey: 'not-a-valid-uuid' },
    );
    expect(resMalformed.statusCode).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is editor or viewer', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
  });

  it('returns 403 when administrator invites at role owner (RULING 23)', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.FORBIDDEN,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'newowner@example.test', role: 'owner' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
  });

  it('returns 404 when caller has no membership in the workspace', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.NOT_FOUND,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
  });

  it('returns 409 workspace-invitation-existing-member when email is an active member (RULING 21)', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.EXISTING_MEMBER,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'active@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.WORKSPACE_INVITATION_EXISTING_MEMBER);
    expect(body.code).toBe('workspace-invitation-existing-member');
  });

  it('returns 409 workspace-invitation-already-pending when unexpired pending invitation exists (RULING 21)', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'pending@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.WORKSPACE_INVITATION_ALREADY_PENDING);
    expect(body.code).toBe('workspace-invitation-already-pending');
  });

  it('returns 422 personal-workspace-invitation when workspace kind is personal (RULING 21 / B1)', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.PERSONAL_WORKSPACE,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'someone@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.PERSONAL_WORKSPACE_INVITATION);
    expect(body.code).toBe('personal-workspace-invitation');
  });

  it('returns 422 when request body fails validation', async () => {
    const createSpy = vi.fn();
    const appInstance = await createApplication(undefined, createSpy);

    // Invalid email
    const resInvalidEmail = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'not-an-email', role: 'editor' },
      { token: TOKEN },
    );
    expect(resInvalidEmail.statusCode).toBe(422);

    // Invalid role
    const resInvalidRole = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'valid@example.test', role: 'superadmin' },
      { token: TOKEN },
    );
    expect(resInvalidRole.statusCode).toBe(422);

    // Additional properties
    const resExtra = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      {
        email: 'valid@example.test',
        role: 'editor',
        extraProperty: 'forbidden',
      },
      { token: TOKEN },
    );
    expect(resExtra.statusCode).toBe(422);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('idempotency: same key same body replays stored 201', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED,
      status: 201,
      body: defaultInvitation,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(defaultInvitation);
  });

  it('idempotency: same key different body returns 409 generic conflict', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'invitee@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.CONFLICT);
    expect(body.code).toBe('conflict');
  });

  it('idempotency: replaying a stored 409 existing-member re-renders with type and code', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED,
      status: 409,
      body: {
        type: PROBLEM_TYPES.WORKSPACE_INVITATION_EXISTING_MEMBER,
        title: 'Workspace member already active with this email',
        status: 409,
      },
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'active@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.WORKSPACE_INVITATION_EXISTING_MEMBER);
    expect(body.code).toBe('workspace-invitation-existing-member');
  });

  it('idempotency: replaying a stored 409 already-pending re-renders with type and code', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      kind: WORKSPACE_INVITATION_CREATE_OUTCOMES.REPLAYED,
      status: 409,
      body: {
        type: PROBLEM_TYPES.WORKSPACE_INVITATION_ALREADY_PENDING,
        title: 'Pending invitation already exists for this email',
        status: 409,
      },
    });
    const appInstance = await createApplication(undefined, createSpy);
    const response = await createWorkspaceInvitationRequest(
      appInstance,
      WORKSPACE_ID,
      { email: 'pending@example.test', role: 'editor' },
      { token: TOKEN },
    );
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.WORKSPACE_INVITATION_ALREADY_PENDING);
    expect(body.code).toBe('workspace-invitation-already-pending');
  });
});
