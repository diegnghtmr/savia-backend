import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEDGER_PORT,
  type LedgerPort,
  type Transaction,
  type TransactionCreateOutcome,
  type TransactionListOutcome,
  type TransactionReadOutcome,
  type TransactionUpdateOutcome,
} from '../src/ledger/ledger.port.js';
import { LedgerModule } from '../src/ledger/ledger.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../src/platform/problem-details.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
const TRANSACTION_ID = '00000000-0000-0000-0000-000000007001';
const ACCOUNT_ID = 'b3a1c2d3-1111-4222-8333-a44455556666';
const CATEGORY_ID = 'c1a1c2d3-1111-4222-8333-a44455556666';

const TRANSACTION: Transaction = {
  id: TRANSACTION_ID,
  type: 'expense',
  status: 'confirmed',
  accountId: ACCOUNT_ID,
  amount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-20T10:00:00.000Z',
  categoryId: null,
  payeeId: null,
  description: 'Groceries',
  notes: null,
  tagIds: [],
  receiptId: null,
  reconciliationId: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  version: 1,
};

const VALID_CREATE_BODY = {
  type: 'expense',
  accountId: ACCOUNT_ID,
  amount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-20T10:00:00.000Z',
  status: 'confirmed',
  description: 'Groceries',
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
  create: LedgerPort['create'] = vi.fn().mockResolvedValue({
    kind: 'created',
    transaction: TRANSACTION,
  } satisfies TransactionCreateOutcome),
  read: LedgerPort['read'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    transaction: TRANSACTION,
  } satisfies TransactionReadOutcome),
  list: LedgerPort['list'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    page: {
      items: [TRANSACTION],
      pageInfo: { hasNextPage: false, nextCursor: null },
    },
  } satisfies TransactionListOutcome),
  update: LedgerPort['update'] = vi.fn().mockResolvedValue({
    kind: 'ok',
    transaction: { ...TRANSACTION, version: 2 },
  } satisfies TransactionUpdateOutcome),
): Promise<{
  application: NestFastifyApplication;
  create: LedgerPort['create'];
  read: LedgerPort['read'];
  list: LedgerPort['list'];
  update: LedgerPort['update'];
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [LedgerModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(LEDGER_PORT)
    .useValue({ create, read, list, update })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { application: app, create, read, list, update };
}

function postTransaction(
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
    url: '/v1/transactions',
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getTransaction(
  application: NestFastifyApplication,
  transactionId: string,
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
    url: `/v1/transactions/${transactionId}`,
    headers,
  });
}

function listTransactions(
  application: NestFastifyApplication,
  queryString = '',
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
  const url = queryString
    ? `/v1/transactions?${queryString}`
    : '/v1/transactions';
  return application.inject({
    method: 'GET',
    url,
    headers,
  });
}

function patchTransaction(
  application: NestFastifyApplication,
  transactionId: string,
  body: unknown,
  options: {
    token?: string;
    workspaceHeader?: string;
    idempotencyKey?: string;
    ifMatch?: string;
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
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
  return application.inject({
    method: 'PATCH',
    url: `/v1/transactions/${transactionId}`,
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /v1/transactions/:transactionId', () => {
  it('answers 200 with transaction body, strong quoted ETag, and passes exact transactionId path parameter to the port', async () => {
    const read = vi.fn<LedgerPort['read']>().mockResolvedValue({
      kind: 'ok',
      transaction: TRANSACTION,
    } satisfies TransactionReadOutcome);
    const { application } = await createApplication(undefined, read);

    const response = await getTransaction(application, TRANSACTION.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers.etag).toBe(`"${TRANSACTION.version}"`);
    expect(JSON.parse(response.payload)).toEqual(TRANSACTION);
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, TRANSACTION.id);
  });

  it('pins the ETag header value to the integer version and verifies it changes when version changes', async () => {
    const v1Transaction = { ...TRANSACTION, version: 1 };
    const v2Transaction = { ...TRANSACTION, version: 2 };
    const v42Transaction = { ...TRANSACTION, version: 42 };

    const read = vi
      .fn<LedgerPort['read']>()
      .mockResolvedValueOnce({ kind: 'ok', transaction: v1Transaction })
      .mockResolvedValueOnce({ kind: 'ok', transaction: v2Transaction })
      .mockResolvedValueOnce({ kind: 'ok', transaction: v42Transaction });

    const { application } = await createApplication(undefined, read);

    const res1 = await getTransaction(application, TRANSACTION.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers.etag).toBe('"1"');

    const res2 = await getTransaction(application, TRANSACTION.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers.etag).toBe('"2"');

    const res3 = await getTransaction(application, TRANSACTION.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.headers.etag).toBe('"42"');
  });

  it('answers 401 without a bearer token or with an invalid token', async () => {
    const read = vi.fn<LedgerPort['read']>();
    const { application } = await createApplication(undefined, read);

    const responseWithoutToken = await getTransaction(
      application,
      TRANSACTION.id,
      {
        workspaceHeader: WORKSPACE_ID,
      },
    );
    expect(responseWithoutToken.statusCode).toBe(401);
    const body1 = responseWithoutToken.json() as {
      type: string;
      status: number;
    };
    expect(body1.status).toBe(401);

    const responseWithBadToken = await getTransaction(
      application,
      TRANSACTION.id,
      {
        token: 'bad-token',
        workspaceHeader: WORKSPACE_ID,
      },
    );
    expect(responseWithBadToken.statusCode).toBe(401);
    const body2 = responseWithBadToken.json() as {
      type: string;
      status: number;
    };
    expect(body2.status).toBe(401);

    expect(read).not.toHaveBeenCalled();
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const read = vi.fn<LedgerPort['read']>();
    const { application } = await createApplication(undefined, read);
    const response = await getTransaction(application, TRANSACTION.id, {
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
    const read = vi.fn<LedgerPort['read']>();
    const { application } = await createApplication(undefined, read);
    const response = await getTransaction(application, TRANSACTION.id, {
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

  it('answers 400 when transactionId path parameter is not a valid UUID', async () => {
    const read = vi.fn<LedgerPort['read']>();
    const { application } = await createApplication(undefined, read);
    const response = await getTransaction(application, 'invalid-uuid-segment', {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid transaction identifier');
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when the port reports forbidden', async () => {
    const read = vi.fn<LedgerPort['read']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies TransactionReadOutcome);
    const { application } = await createApplication(undefined, read);
    const response = await getTransaction(application, TRANSACTION.id, {
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
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, TRANSACTION.id);
  });

  it('answers 404 problem+json when the port reports not-found', async () => {
    const read = vi.fn<LedgerPort['read']>().mockResolvedValue({
      kind: 'not_found',
    } satisfies TransactionReadOutcome);
    const { application } = await createApplication(undefined, read);
    const response = await getTransaction(application, TRANSACTION.id, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Transaction not found');
    expect(body.status).toBe(404);
    expect(read).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, TRANSACTION.id);
  });
});

describe('POST /v1/transactions', () => {
  it('answers 201 with created transaction, exact quoted version ETag header, and passes workspaceId and idempotencyKey from headers', async () => {
    const create = vi.fn<LedgerPort['create']>().mockResolvedValue({
      kind: 'created',
      transaction: TRANSACTION,
    } satisfies TransactionCreateOutcome);
    const { application } = await createApplication(create);

    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers.etag).toBe(`"${TRANSACTION.version}"`);
    expect(JSON.parse(response.payload)).toEqual(TRANSACTION);
    expect(create).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      {
        type: 'expense',
        accountId: ACCOUNT_ID,
        amount: {
          amountMinor: '5000',
          currency: 'USD',
        },
        occurredAt: '2026-08-20T10:00:00.000Z',
        status: 'confirmed',
        categoryId: null,
        payeeId: null,
        description: 'Groceries',
        notes: null,
        tagIds: [],
        receiptId: null,
      },
      IDEMPOTENCY_KEY,
    );
  });

  it('answers 201 replayed with stored status, etag, and body when idempotency replay matches', async () => {
    const create = vi.fn<LedgerPort['create']>().mockResolvedValue({
      kind: 'replayed',
      status: 201,
      etag: `"${TRANSACTION.version}"`,
      body: TRANSACTION,
    } satisfies TransactionCreateOutcome);
    const { application } = await createApplication(create);

    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe(`"${TRANSACTION.version}"`);
    expect(JSON.parse(response.payload)).toEqual(TRANSACTION);
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 when X-Workspace-Id header is not a valid UUID', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: 'not-a-valid-uuid',
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 when Idempotency-Key header is missing', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid Idempotency-Key header');
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 when Idempotency-Key header is not a valid UUID', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: 'not-a-valid-uuid',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid Idempotency-Key header');
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 when body is not valid JSON', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, '{ invalid json', {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 401 when Authorization header is missing', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 401 when bearer token is rejected', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: 'invalid-token',
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when the port reports forbidden', async () => {
    const create = vi.fn<LedgerPort['create']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies TransactionCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Workspace access forbidden');
    expect(body.status).toBe(403);
  });

  it('answers 409 problem+json when the port reports idempotency conflict', async () => {
    const create = vi.fn<LedgerPort['create']>().mockResolvedValue({
      kind: 'idempotency_conflict',
    } satisfies TransactionCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Idempotency key reused with different payload');
    expect(body.status).toBe(409);
  });

  it('answers 422 problem+json when splits array is provided (splits unsupported)', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(
      application,
      {
        ...VALID_CREATE_BODY,
        splits: [
          {
            amount: { amountMinor: '5000', currency: 'USD' },
            categoryId: '00000000-0000-0000-0000-000000000002',
          },
        ],
      },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED);
    expect(body.type).toBe(
      'https://savia.app/problems/transaction-splits-unsupported',
    );
    expect(body.title).toBe('Transaction splits unsupported');
    expect(body.status).toBe(422);
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 422 problem+json when the port reports account_unresolved', async () => {
    const create = vi.fn<LedgerPort['create']>().mockResolvedValue({
      kind: 'account_unresolved',
    } satisfies TransactionCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.ACCOUNT_UNRESOLVED);
    expect(body.type).toBe('https://savia.app/problems/account-unresolved');
    expect(body.title).toBe('Account unresolved');
    expect(body.status).toBe(422);
  });

  it('answers 422 problem+json when the port reports account_closed', async () => {
    const create = vi.fn<LedgerPort['create']>().mockResolvedValue({
      kind: 'account_closed',
    } satisfies TransactionCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransaction(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.ACCOUNT_CLOSED);
    expect(body.type).toBe('https://savia.app/problems/account-closed');
    expect(body.title).toBe('Account is closed');
    expect(body.status).toBe(422);
  });

  it('answers 422 problem+json when request body fails validation', async () => {
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransaction(
      application,
      { type: 'invalid_type', accountId: 'not-a-uuid' },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
    expect(body.type).toBe('https://savia.app/problems/unprocessable');
    expect(body.status).toBe(422);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('ensures the three 422 refusal problem types and unprocessable are distinct literals', () => {
    expect(PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED).toBe(
      'https://savia.app/problems/transaction-splits-unsupported',
    );
    expect(PROBLEM_TYPES.ACCOUNT_UNRESOLVED).toBe(
      'https://savia.app/problems/account-unresolved',
    );
    expect(PROBLEM_TYPES.ACCOUNT_CLOSED).toBe(
      'https://savia.app/problems/account-closed',
    );
    expect(PROBLEM_TYPES.UNPROCESSABLE).toBe(
      'https://savia.app/problems/unprocessable',
    );

    const types = [
      PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED,
      PROBLEM_TYPES.ACCOUNT_UNRESOLVED,
      PROBLEM_TYPES.ACCOUNT_CLOSED,
      PROBLEM_TYPES.UNPROCESSABLE,
    ];
    const uniqueTypes = new Set(types);
    expect(uniqueTypes.size).toBe(4);
  });
});

describe('GET /v1/transactions', () => {
  it('answers 200 with transaction page and exercises query decorator binding over real HTTP', async () => {
    const page = {
      items: [TRANSACTION],
      pageInfo: { hasNextPage: false, nextCursor: null },
    };
    const list = vi.fn<LedgerPort['list']>().mockResolvedValue({
      kind: 'ok',
      page,
    } satisfies TransactionListOutcome);
    const { application } = await createApplication(undefined, undefined, list);

    const queryString = `limit=25&accountId=${ACCOUNT_ID}&status=confirmed&categoryId=${CATEGORY_ID}&from=2026-08-01&to=2026-08-31&query=Groceries`;
    const response = await listTransactions(application, queryString, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.payload)).toEqual(page);

    expect(list).toHaveBeenCalledWith(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      limit: 25,
      accountId: ACCOUNT_ID,
      status: 'confirmed',
      categoryId: CATEGORY_ID,
      from: '2026-08-01',
      to: '2026-08-31',
      query: 'Groceries',
    });
  });

  it('answers 401 without bearer token or with rejected token', async () => {
    const list = vi.fn<LedgerPort['list']>();
    const { application } = await createApplication(undefined, undefined, list);

    const res1 = await listTransactions(application, '', {
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res1.statusCode).toBe(401);

    const res2 = await listTransactions(application, '', {
      token: 'bad-token',
      workspaceHeader: WORKSPACE_ID,
    });
    expect(res2.statusCode).toBe(401);

    expect(list).not.toHaveBeenCalled();
  });

  it('answers 400 when X-Workspace-Id header is missing or not a UUID', async () => {
    const list = vi.fn<LedgerPort['list']>();
    const { application } = await createApplication(undefined, undefined, list);

    const res1 = await listTransactions(application, '', { token: TOKEN });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().title).toBe('Invalid X-Workspace-Id header');

    const res2 = await listTransactions(application, '', {
      token: TOKEN,
      workspaceHeader: 'not-a-uuid',
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().title).toBe('Invalid X-Workspace-Id header');

    expect(list).not.toHaveBeenCalled();
  });

  it('answers 400 when query parameter is invalid', async () => {
    const list = vi.fn<LedgerPort['list']>();
    const { application } = await createApplication(undefined, undefined, list);

    const response = await listTransactions(application, 'limit=not-a-number', {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = response.json();
    expect(body.title).toBe('Invalid list transactions query');
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when port returns forbidden', async () => {
    const list = vi.fn<LedgerPort['list']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies TransactionListOutcome);
    const { application } = await createApplication(undefined, undefined, list);

    const response = await listTransactions(application, '', {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = response.json();
    expect(body.title).toBe('Workspace access forbidden');
    expect(body.status).toBe(403);
  });
});

describe('PATCH /v1/transactions/:transactionId', () => {
  const validUpdateBody = {
    description: 'Updated Groceries',
    status: 'pending',
  };

  it('answers 200 with updated transaction, strong quoted version ETag header, and passes all parameters to the port', async () => {
    const updatedTransaction = {
      ...TRANSACTION,
      description: 'Updated Groceries',
      status: 'pending' as const,
      version: 2,
    };
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'ok',
      transaction: updatedTransaction,
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        ifMatch: '"1"',
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers.etag).toBe('"2"');
    expect(JSON.parse(response.payload)).toEqual(updatedTransaction);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      TRANSACTION.id,
      {
        description: 'Updated Groceries',
        status: 'pending',
      },
      IDEMPOTENCY_KEY,
      1,
    );
  });

  it('answers 200 when If-Match header is omitted, passing expectedVersions as undefined', async () => {
    const updatedTransaction = { ...TRANSACTION, version: 2 };
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'ok',
      transaction: updatedTransaction,
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      TRANSACTION.id,
      {
        description: 'Updated Groceries',
        status: 'pending',
      },
      IDEMPOTENCY_KEY,
      undefined,
    );
  });

  it('answers 200 replayed with stored status, etag, and body when idempotency replay matches', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'replayed',
      status: 200,
      etag: '"2"',
      body: { ...TRANSACTION, version: 2 },
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(JSON.parse(response.payload)).toEqual({
      ...TRANSACTION,
      version: 2,
    });
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 400 when transactionId path parameter is not a valid UUID', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      'not-a-uuid',
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid transaction identifier');
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 400 when Idempotency-Key header is missing', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid Idempotency-Key header');
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 400 when body is not valid JSON', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      '{ invalid json',
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 401 when Authorization header is missing or bearer token is rejected', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const res1 = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );
    expect(res1.statusCode).toBe(401);

    const res2 = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: 'invalid-token',
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );
    expect(res2.statusCode).toBe(401);

    expect(update).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when port reports forbidden', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Workspace access forbidden');
    expect(body.status).toBe(403);
  });

  it('answers 409 problem+json with title "Transaction is voided" and TRANSACTION_VOIDED type when port reports voided', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'voided',
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.TRANSACTION_VOIDED);
    expect(body.title).toBe('Transaction is voided');
    expect(body.status).toBe(409);
  });

  it('answers 404 problem+json when port reports not_found', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'not_found',
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Transaction not found');
    expect(body.status).toBe(404);
  });

  it('answers 409 problem+json when port reports idempotency conflict', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'idempotency_conflict',
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Idempotency key reused with different payload');
    expect(body.status).toBe(409);
  });

  it('answers 409 problem+json with transaction-reconciled problem type when port reports reconciled (Épica 5 stub)', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'reconciled',
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.TRANSACTION_RECONCILED);
    expect(body.type).toBe('https://savia.app/problems/transaction-reconciled');
    expect(body.title).toBe('Transaction is reconciled');
    expect(body.status).toBe(409);
  });

  it('answers 412 problem+json when If-Match header is malformed', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        ifMatch: 'malformed-etag',
      },
    );

    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.PRECONDITION_FAILED);
    expect(body.status).toBe(412);
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 412 problem+json when port reports version_conflict (stale version)', async () => {
    const update = vi.fn<LedgerPort['update']>().mockResolvedValue({
      kind: 'version_conflict',
    } satisfies TransactionUpdateOutcome);
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      validUpdateBody,
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        ifMatch: '"1"',
      },
    );

    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.PRECONDITION_FAILED);
    expect(body.title).toBe('Resource version mismatch');
    expect(body.status).toBe(412);
  });

  it('answers 422 problem+json when body is empty object (empty-update, minProperties: 1)', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      {},
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
    expect(body.errors).toContainEqual({
      field: 'body',
      code: 'empty-update',
      message: 'must contain at least one field to update',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 422 problem+json when body contains unknown or immutable fields (additionalProperties: false)', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const { application } = await createApplication(
      undefined,
      undefined,
      undefined,
      update,
    );

    const response = await patchTransaction(
      application,
      TRANSACTION.id,
      {
        ...validUpdateBody,
        amount: { amountMinor: '5000', currency: 'USD' },
      },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
    expect(body.errors).toContainEqual({
      field: 'amount',
      code: 'not-allowed',
      message: 'is not allowed',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 422 problem+json when splits array is non-empty and asserts literal equality of problem type with POST', async () => {
    const update = vi.fn<LedgerPort['update']>();
    const create = vi.fn<LedgerPort['create']>();
    const { application } = await createApplication(
      create,
      undefined,
      undefined,
      update,
    );

    const postResponse = await postTransaction(
      application,
      {
        ...VALID_CREATE_BODY,
        splits: [
          {
            amount: { amountMinor: '5000', currency: 'USD' },
            categoryId: CATEGORY_ID,
          },
        ],
      },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    const patchResponse = await patchTransaction(
      application,
      TRANSACTION.id,
      {
        splits: [
          {
            amount: { amountMinor: '5000', currency: 'USD' },
            categoryId: CATEGORY_ID,
          },
        ],
      },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(postResponse.statusCode).toBe(422);
    expect(patchResponse.statusCode).toBe(422);

    const postBody = JSON.parse(postResponse.payload);
    const patchBody = JSON.parse(patchResponse.payload);

    expect(postBody.type).toBe(PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED);
    expect(patchBody.type).toBe(PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED);
    // Assert LITERAL EQUALITY of the problem-type string emitted by both operations:
    expect(patchBody.type).toBe(postBody.type);
    expect(patchBody.title).toBe(postBody.title);
  });
});
