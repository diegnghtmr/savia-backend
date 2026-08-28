import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TRANSFER_PORT,
  type TransferPort,
  type Transfer,
  type TransferCreateOutcome,
} from '../src/ledger/transfer.port.js';
import { LedgerModule } from '../src/ledger/ledger.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../src/platform/problem-details.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
const TRANSFER_ID = '00000000-0000-0000-0000-000000008001';
const SOURCE_ACCOUNT_ID = 'b3a1c2d3-1111-4222-8333-a44455556666';
const DEST_ACCOUNT_ID = 'c3a1c2d3-2222-4222-8333-a44455556666';

const TRANSFER: Transfer = {
  id: TRANSFER_ID,
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  sourceAmount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  destinationAmount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-25T10:00:00.000Z',
  status: 'confirmed',
  version: 1,
};

const VALID_CREATE_BODY = {
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  amount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-25T10:00:00.000Z',
  description: 'Regular transfer',
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
  create: TransferPort['create'] = vi.fn().mockResolvedValue({
    kind: 'created',
    transfer: TRANSFER,
  } satisfies TransferCreateOutcome),
): Promise<{
  application: NestFastifyApplication;
  create: TransferPort['create'];
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [LedgerModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(TRANSFER_PORT)
    .useValue({ create })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { application: app, create };
}

function postTransfer(
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
    url: '/v1/transfers',
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /v1/transfers', () => {
  it('answers 201 with created transfer, NO ETag header, and passes workspaceId and idempotencyKey from headers', async () => {
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'created',
      transfer: TRANSFER,
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);

    const response = await postTransfer(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers.etag).toBeUndefined();
    expect(JSON.parse(response.payload)).toEqual(TRANSFER);
    expect(create).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      {
        sourceAccountId: SOURCE_ACCOUNT_ID,
        destinationAccountId: DEST_ACCOUNT_ID,
        amount: {
          amountMinor: '5000',
          currency: 'USD',
        },
        occurredAt: '2026-08-25T10:00:00.000Z',
        description: 'Regular transfer',
      },
      IDEMPOTENCY_KEY,
    );
  });

  it('answers 201 with fee and transactionId only when fee is present', async () => {
    const transferWithFee: Transfer = {
      ...TRANSFER,
      fee: {
        amountMinor: '100',
        currency: 'USD',
      },
      transactionId: '00000000-0000-0000-0000-000000007001',
    };
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'created',
      transfer: transferWithFee,
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);

    const response = await postTransfer(
      application,
      {
        ...VALID_CREATE_BODY,
        fee: { amountMinor: '100', currency: 'USD' },
      },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.fee).toEqual({ amountMinor: '100', currency: 'USD' });
    expect(body.transactionId).toBe('00000000-0000-0000-0000-000000007001');
  });

  it('answers 201 replayed with stored status and body when idempotency replay matches', async () => {
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'replayed',
      status: 201,
      etag: null,
      body: TRANSFER,
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);

    const response = await postTransfer(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBeUndefined();
    expect(JSON.parse(response.payload)).toEqual(TRANSFER);
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const create = vi.fn<TransferPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    const create = vi.fn<TransferPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    const create = vi.fn<TransferPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    const create = vi.fn<TransferPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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

  it('answers 401 when Authorization header is missing', async () => {
    const create = vi.fn<TransferPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'idempotency_conflict',
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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

  it('answers 422 problem+json when the port reports account_unresolved', async () => {
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'account_unresolved',
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    expect(body.title).toBe('Account unresolved');
    expect(body.status).toBe(422);
  });

  it('answers 422 problem+json when the port reports account_closed', async () => {
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'account_closed',
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
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
    expect(body.title).toBe('Account is closed');
    expect(body.status).toBe(422);
  });

  it('answers 422 problem+json when the port reports currency_mismatch', async () => {
    const create = vi.fn<TransferPort['create']>().mockResolvedValue({
      kind: 'currency_mismatch',
    } satisfies TransferCreateOutcome);
    const { application } = await createApplication(create);
    const response = await postTransfer(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.TRANSFER_CURRENCY_MISMATCH);
    expect(body.title).toBe('Transfer currency mismatch');
    expect(body.status).toBe(422);
  });

  it('answers 422 problem+json when request body fails validation (e.g. self-transfer)', async () => {
    const create = vi.fn<TransferPort['create']>();
    const { application } = await createApplication(create);
    const response = await postTransfer(
      application,
      {
        ...VALID_CREATE_BODY,
        destinationAccountId: SOURCE_ACCOUNT_ID,
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
    expect(body.status).toBe(422);
    expect(body.errors).toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
});
