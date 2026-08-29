import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCHANGE_RATE_PORT,
  type ExchangeRatePort,
  type ExchangeRate,
  type ExchangeRateCreateOutcome,
  type ExchangeRateListOutcome,
} from '../src/currencies/exchange-rate.port.js';
import { CurrenciesModule } from '../src/currencies/currencies.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';
import { PROBLEM_TYPES } from '../src/platform/problem-details.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
const EXCHANGE_RATE_ID = '00000000-0000-0000-0000-000000008001';

const EXCHANGE_RATE: ExchangeRate = {
  id: EXCHANGE_RATE_ID,
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: '0.9200',
  effectiveAt: '2026-08-28T12:00:00.000Z',
  source: 'manual',
  manual: true,
};

const VALID_CREATE_BODY = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: '0.9200',
  effectiveAt: '2026-08-28T12:00:00.000Z',
  notes: 'Manual rate entry',
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
  optionsOrPort?:
    | ExchangeRatePort['createManual']
    | {
        createManual?: ExchangeRatePort['createManual'];
        list?: ExchangeRatePort['list'];
      },
): Promise<{
  application: NestFastifyApplication;
  createManual: ExchangeRatePort['createManual'];
  list: ExchangeRatePort['list'];
}> {
  const createManual =
    typeof optionsOrPort === 'function'
      ? optionsOrPort
      : (optionsOrPort?.createManual ??
        vi.fn().mockResolvedValue({
          kind: 'created',
          exchangeRate: EXCHANGE_RATE,
        } satisfies ExchangeRateCreateOutcome));

  const list =
    typeof optionsOrPort === 'function'
      ? vi.fn().mockResolvedValue({
          kind: 'ok',
          exchangeRates: [EXCHANGE_RATE],
        } satisfies ExchangeRateListOutcome)
      : (optionsOrPort?.list ??
        vi.fn().mockResolvedValue({
          kind: 'ok',
          exchangeRates: [EXCHANGE_RATE],
        } satisfies ExchangeRateListOutcome));

  const moduleRef = await Test.createTestingModule({
    imports: [CurrenciesModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(EXCHANGE_RATE_PORT)
    .useValue({ createManual, list })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ exposeHeadRoutes: false }),
  );
  registerProblemFilter(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { application: app, createManual, list };
}

function postExchangeRate(
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
    url: '/v1/exchange-rates',
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getExchangeRates(
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
  const url = `/v1/exchange-rates${queryString ? `?${queryString}` : ''}`;

  return application.inject({
    method: 'GET',
    url,
    headers,
  });
}

describe('POST /v1/exchange-rates', () => {
  it('answers 201 with created exchange rate, NO ETag header, and passes workspaceId and idempotencyKey from headers', async () => {
    const createManual = vi
      .fn<ExchangeRatePort['createManual']>()
      .mockResolvedValue({
        kind: 'created',
        exchangeRate: EXCHANGE_RATE,
      } satisfies ExchangeRateCreateOutcome);
    const { application } = await createApplication(createManual);

    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers.etag).toBeUndefined();
    expect(JSON.parse(response.payload)).toEqual(EXCHANGE_RATE);
    expect(createManual).toHaveBeenCalledWith(
      SUBJECT,
      WORKSPACE_ID,
      {
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.9200',
        effectiveAt: '2026-08-28T12:00:00.000Z',
        notes: 'Manual rate entry',
      },
      IDEMPOTENCY_KEY,
    );
  });

  it('answers 201 replayed with stored status and body when idempotency replay matches', async () => {
    const createManual = vi
      .fn<ExchangeRatePort['createManual']>()
      .mockResolvedValue({
        kind: 'replayed',
        status: 201,
        etag: null,
        body: EXCHANGE_RATE,
      } satisfies ExchangeRateCreateOutcome);
    const { application } = await createApplication(createManual);

    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBeUndefined();
    expect(JSON.parse(response.payload)).toEqual(EXCHANGE_RATE);
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const createManual = vi.fn<ExchangeRatePort['createManual']>();
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
      token: TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(createManual).not.toHaveBeenCalled();
  });

  it('answers 400 when X-Workspace-Id header is not a valid UUID', async () => {
    const createManual = vi.fn<ExchangeRatePort['createManual']>();
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
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
    expect(createManual).not.toHaveBeenCalled();
  });

  it('answers 400 when Idempotency-Key header is missing', async () => {
    const createManual = vi.fn<ExchangeRatePort['createManual']>();
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid Idempotency-Key header');
    expect(createManual).not.toHaveBeenCalled();
  });

  it('answers 400 when Idempotency-Key header is not a valid UUID', async () => {
    const createManual = vi.fn<ExchangeRatePort['createManual']>();
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
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
    expect(createManual).not.toHaveBeenCalled();
  });

  it('answers 401 when Authorization header is missing', async () => {
    const createManual = vi.fn<ExchangeRatePort['createManual']>();
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(createManual).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when the port reports forbidden', async () => {
    const createManual = vi
      .fn<ExchangeRatePort['createManual']>()
      .mockResolvedValue({
        kind: 'forbidden',
      } satisfies ExchangeRateCreateOutcome);
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
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
    const createManual = vi
      .fn<ExchangeRatePort['createManual']>()
      .mockResolvedValue({
        kind: 'idempotency_conflict',
      } satisfies ExchangeRateCreateOutcome);
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
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

  it('answers 409 problem+json when the port reports already_recorded', async () => {
    const createManual = vi
      .fn<ExchangeRatePort['createManual']>()
      .mockResolvedValue({
        kind: 'already_recorded',
      } satisfies ExchangeRateCreateOutcome);
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(application, VALID_CREATE_BODY, {
      token: TOKEN,
      workspaceHeader: WORKSPACE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.type).toBe(PROBLEM_TYPES.EXCHANGE_RATE_ALREADY_RECORDED);
    expect(body.title).toBe('Exchange rate already recorded');
    expect(body.status).toBe(409);
  });

  it('answers 422 problem+json when request body fails validation (e.g. rate <= 0)', async () => {
    const createManual = vi.fn<ExchangeRatePort['createManual']>();
    const { application } = await createApplication(createManual);
    const response = await postExchangeRate(
      application,
      {
        ...VALID_CREATE_BODY,
        rate: '-0.5',
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
    expect(createManual).not.toHaveBeenCalled();
  });
});

describe('GET /v1/exchange-rates', () => {
  it('answers 200 with plain array of exchange rates, NO ETag header, and passes workspaceId and query filters to port', async () => {
    const list = vi.fn<ExchangeRatePort['list']>().mockResolvedValue({
      kind: 'ok',
      exchangeRates: [EXCHANGE_RATE],
    } satisfies ExchangeRateListOutcome);
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      {
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        from: '2026-08-01',
        to: '2026-08-28',
      },
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers.etag).toBeUndefined();
    expect(JSON.parse(response.payload)).toEqual([EXCHANGE_RATE]);
    expect(list).toHaveBeenCalledWith(SUBJECT, {
      workspaceId: WORKSPACE_ID,
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      from: '2026-08-01',
      to: '2026-08-28',
    });
  });

  it('answers 200 with empty array when no exchange rates match (not an error)', async () => {
    const list = vi.fn<ExchangeRatePort['list']>().mockResolvedValue({
      kind: 'ok',
      exchangeRates: [],
    } satisfies ExchangeRateListOutcome);
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      {},
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.payload)).toEqual([]);
  });

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const list = vi.fn<ExchangeRatePort['list']>();
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      {},
      {
        token: TOKEN,
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 400 when X-Workspace-Id header is not a valid UUID', async () => {
    const list = vi.fn<ExchangeRatePort['list']>();
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      {},
      {
        token: TOKEN,
        workspaceHeader: 'not-a-valid-uuid',
      },
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = JSON.parse(response.payload);
    expect(body.title).toBe('Invalid X-Workspace-Id header');
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 400 when query parameter is malformed (e.g. lowercase baseCurrency)', async () => {
    const list = vi.fn<ExchangeRatePort['list']>();
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      { baseCurrency: 'usd' },
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
    expect(body.title).toBe('Invalid list exchange rates query');
    expect(body.status).toBe(400);
    expect(body.errors).toBeDefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 400 when from/to date query parameter is malformed', async () => {
    const list = vi.fn<ExchangeRatePort['list']>();
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      { from: '2026-99-99' },
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
    expect(body.title).toBe('Invalid list exchange rates query');
    expect(body.status).toBe(400);
    expect(body.errors).toBeDefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 401 when Authorization header is missing', async () => {
    const list = vi.fn<ExchangeRatePort['list']>();
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      {},
      {
        workspaceHeader: WORKSPACE_ID,
      },
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 403 problem+json when the port reports forbidden', async () => {
    const list = vi.fn<ExchangeRatePort['list']>().mockResolvedValue({
      kind: 'forbidden',
    } satisfies ExchangeRateListOutcome);
    const { application } = await createApplication({ list });

    const response = await getExchangeRates(
      application,
      {},
      {
        token: TOKEN,
        workspaceHeader: WORKSPACE_ID,
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
});
