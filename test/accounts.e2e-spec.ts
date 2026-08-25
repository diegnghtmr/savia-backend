import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNTS_PORT,
  ACCOUNT_READ_OUTCOMES,
  type Account,
  type AccountListOutcome,
  type AccountListQuery,
  type AccountReadOutcome,
  type AccountsPort,
} from '../src/accounts/accounts.port.js';
import { AccountsModule } from '../src/accounts/accounts.module.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../src/identity/problem-details.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';

const ACCOUNT: Account = {
  id: 'b3a1c2d3-1111-4222-8333-a44455556666',
  name: 'Cash wallet',
  type: 'cash',
  currency: 'USD',
  status: 'active',
  institution: null,
  maskedNumber: null,
  description: null,
  colorToken: null,
  icon: null,
  includeInNetWorth: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
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
  list: AccountsPort['list'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    page: {
      items: [ACCOUNT],
      pageInfo: { hasNextPage: false, nextCursor: null },
    },
  } satisfies AccountListOutcome),
  read: AccountsPort['read'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    account: ACCOUNT,
  } satisfies AccountReadOutcome),
): Promise<{
  application: NestFastifyApplication;
  list: AccountsPort['list'];
  read: AccountsPort['read'];
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AccountsModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(ACCOUNTS_PORT)
    .useValue({ list, read })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { application: app, list, read };
}

function getAccounts(
  application: NestFastifyApplication,
  options: {
    token?: string;
    workspaceHeader?: string;
    cursor?: string;
    limit?: string;
    status?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token !== undefined)
    headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceHeader !== undefined)
    headers['x-workspace-id'] = options.workspaceHeader;
  const search = new URLSearchParams();
  if (options.cursor !== undefined) search.set('cursor', options.cursor);
  if (options.limit !== undefined) search.set('limit', options.limit);
  if (options.status !== undefined) search.set('status', options.status);
  const suffix = search.size === 0 ? '' : `?${search.toString()}`;
  return application.inject({
    method: 'GET',
    url: `/v1/accounts${suffix}`,
    headers,
  });
}

function getAccount(
  application: NestFastifyApplication,
  accountId: string,
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
  return application.inject({
    method: 'GET',
    url: `/v1/accounts/${accountId}`,
    headers,
  });
}

function okPage(): AccountListOutcome {
  return {
    kind: 'ok',
    page: { items: [], pageInfo: { hasNextPage: false, nextCursor: null } },
  };
}

describe('GET /v1/accounts', () => {
  it('answers 200 with the account page shape', async () => {
    const list = vi.fn<AccountsPort['list']>().mockResolvedValue({
      kind: 'ok',
      page: {
        items: [ACCOUNT],
        pageInfo: { hasNextPage: true, nextCursor: 'opaque-cursor' },
      },
    } satisfies AccountListOutcome);
    const { application } = await createApplication(list);
    const response = await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    const body = response.json() as {
      items: Account[];
      pageInfo: { hasNextPage: boolean; nextCursor: string | null };
    };
    expect(body.items).toEqual([ACCOUNT]);
    expect(body.pageInfo).toEqual({
      hasNextPage: true,
      nextCursor: 'opaque-cursor',
    });
    expect(list).toHaveBeenCalledWith(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      cursor: undefined,
      limit: 50,
      status: undefined,
    });
  });

  it('answers 403 for a subject with no membership and never an empty 200', async () => {
    const { application } = await createApplication(
      vi.fn<AccountsPort['list']>().mockResolvedValue({
        kind: 'forbidden',
      } satisfies AccountListOutcome),
    );
    const response = await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(response.statusCode).toBe(403);
    expect(response.statusCode).not.toBe(200);
    const body = response.json() as { type: string; status: number };
    expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
    expect(body.status).toBe(403);
    expect(body).not.toHaveProperty('items');
  });

  it('answers 403 for a workspace that does not exist because there is no declared 404', async () => {
    // Same refusal path: the authority declares 200/401/403 only, so an absent
    // workspace must be indistinguishable from a denied one.
    const { application } = await createApplication(
      vi.fn<AccountsPort['list']>().mockResolvedValue({
        kind: 'forbidden',
      } satisfies AccountListOutcome),
    );
    const response = await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { type: string }).type).toBe(
      PROBLEM_TYPES.FORBIDDEN,
    );
  });

  it('rejects a missing X-Workspace-Id header with 400', async () => {
    const list = vi.fn<AccountsPort['list']>();
    const { application } = await createApplication(list);
    const response = await getAccounts(application, { token: TOKEN });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { type: string }).type).toBe(
      PROBLEM_TYPES.BAD_REQUEST,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a malformed X-Workspace-Id header with 400', async () => {
    const list = vi.fn<AccountsPort['list']>();
    const { application } = await createApplication(list);
    const response = await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: 'not-a-uuid',
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { type: string }).type).toBe(
      PROBLEM_TYPES.BAD_REQUEST,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it.each([['abc'], ['0'], ['201'], ['-1']])(
    'rejects limit %s with 400',
    async (limit) => {
      const list = vi.fn<AccountsPort['list']>();
      const { application } = await createApplication(list);
      const response = await getAccounts(application, {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        limit,
      });
      expect(response.statusCode).toBe(400);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed cursor with 400', async () => {
    const list = vi.fn<AccountsPort['list']>();
    const { application } = await createApplication(list);
    const response = await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      cursor: '!!!not-base64url!!!',
    });
    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an unknown status enum value with 400', async () => {
    const list = vi.fn<AccountsPort['list']>();
    const { application } = await createApplication(list);
    const response = await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      status: 'frozen',
    });
    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 401 without a bearer token', async () => {
    const { application } = await createApplication();
    const response = await getAccounts(application, {
      workspaceHeader: WORKSPACE_ID,
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as { type: string; status: number };
    expect(body.status).toBe(401);
  });

  it('defaults the limit to 50, honours bounds 1 and 200, and forwards the status filter', async () => {
    const captured: AccountListQuery[] = [];
    const list = vi
      .fn<AccountsPort['list']>()
      .mockImplementation(
        async (
          _subject: string,
          query: AccountListQuery,
        ): Promise<AccountListOutcome> => {
          captured.push(query);
          return okPage();
        },
      );
    const { application } = await createApplication(list);

    await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      limit: '1',
    });
    await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      limit: '200',
    });
    await getAccounts(application, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      status: 'archived',
    });

    expect(captured.map((query) => query.limit)).toEqual([50, 1, 200, 50]);
    expect(captured[0]?.status).toBeUndefined();
    expect(captured[3]?.status).toBe('archived');
  });
});

describe('GET /v1/accounts/:accountId', () => {
  it('answers 200 with the account body and the strong ETag header when the account exists', async () => {
    const read = vi.fn<AccountsPort['read']>().mockResolvedValue({
      kind: 'ok',
      account: ACCOUNT,
    } satisfies AccountReadOutcome);
    const { application } = await createApplication(undefined, read);
    const response = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['etag']).toBe('"1"');
    expect(JSON.parse(response.payload)).toEqual(ACCOUNT);
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, ACCOUNT.id);
  });

  it('pins the ETag header value to the integer version and verifies it changes when version changes', async () => {
    const v1Account = { ...ACCOUNT, version: 1 };
    const v2Account = { ...ACCOUNT, version: 2 };
    const v42Account = { ...ACCOUNT, version: 42 };

    const read = vi
      .fn<AccountsPort['read']>()
      .mockResolvedValueOnce({ kind: 'ok', account: v1Account })
      .mockResolvedValueOnce({ kind: 'ok', account: v2Account })
      .mockResolvedValueOnce({ kind: 'ok', account: v42Account });

    const { application } = await createApplication(undefined, read);

    const res1 = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['etag']).toBe('"1"');

    const res2 = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['etag']).toBe('"2"');

    const res3 = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.headers['etag']).toBe('"42"');
  });

  it('answers 401 without a bearer token or with an invalid token', async () => {
    const { application } = await createApplication();
    const responseWithoutToken = await getAccount(application, ACCOUNT.id, {
      workspaceHeader: WORKSPACE_ID,
    });
    expect(responseWithoutToken.statusCode).toBe(401);
    const body1 = responseWithoutToken.json() as {
      type: string;
      status: number;
    };
    expect(body1.status).toBe(401);

    const responseWithBadToken = await getAccount(application, ACCOUNT.id, {
      token: 'bad-token',
      workspaceHeader: WORKSPACE_ID,
    });
    expect(responseWithBadToken.statusCode).toBe(401);
    const body2 = responseWithBadToken.json() as {
      type: string;
      status: number;
    };
    expect(body2.status).toBe(401);
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const read = vi.fn<AccountsPort['read']>();
    const { application } = await createApplication(undefined, read);
    const response = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 400 when X-Workspace-Id header is malformed', async () => {
    const read = vi.fn<AccountsPort['read']>();
    const { application } = await createApplication(undefined, read);
    const response = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: 'not-a-valid-uuid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 400 when accountId path parameter is not a valid UUID', async () => {
    const read = vi.fn<AccountsPort['read']>();
    const { application } = await createApplication(undefined, read);
    const response = await getAccount(application, 'invalid-uuid-segment', {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid account identifier');
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when the port reports forbidden', async () => {
    const read = vi.fn<AccountsPort['read']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies AccountReadOutcome);
    const { application } = await createApplication(undefined, read);
    const response = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Workspace access forbidden');
    expect(body.status).toBe(403);
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, ACCOUNT.id);
  });

  it('answers 404 problem+json when the port reports not-found', async () => {
    const read = vi.fn<AccountsPort['read']>().mockResolvedValue({
      kind: 'not_found',
    } satisfies AccountReadOutcome);
    const { application } = await createApplication(undefined, read);
    const response = await getAccount(application, ACCOUNT.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Account not found');
    expect(body.status).toBe(404);
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, ACCOUNT.id);
  });
});

