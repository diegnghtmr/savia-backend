import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RECURRING_RULES_PORT,
  type RecurringRulesPort,
  type RecurringRule,
} from '../src/recurring/recurring.port.js';
import { RecurringModule } from '../src/recurring/recurring.module.js';
import { JoseJwtVerifier } from '../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'accepted-token';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';

const MOCK_RULE: RecurringRule = {
  id: '00000000-0000-0000-0000-000000001001',
  name: 'Gym Membership',
  frequency: 'monthly',
  rrule: null,
  behavior: 'create_draft',
  template: {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000002001',
    amount: {
      amountMinor: '4500',
      currency: 'USD',
    },
    occurredAt: '2026-08-29T12:00:00.000Z',
    status: 'draft',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: null,
    tagIds: [],
    receiptId: null,
  },
  active: true,
  nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
};

const VALID_CREATE_BODY = {
  name: 'Gym Membership',
  frequency: 'monthly',
  behavior: 'create_draft',
  template: {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000002001',
    amount: {
      amountMinor: '4500',
      currency: 'USD',
    },
    occurredAt: '2026-08-29T12:00:00.000Z',
  },
  startsAt: '2026-08-29T12:00:00.000Z',
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
  overrides: Partial<RecurringRulesPort> = {},
): Promise<{
  application: NestFastifyApplication;
  port: RecurringRulesPort;
}> {
  const port: RecurringRulesPort = {
    createRecurringRule:
      overrides.createRecurringRule ??
      vi.fn().mockResolvedValue({
        kind: 'created',
        rule: MOCK_RULE,
      }),
    listRecurringRules:
      overrides.listRecurringRules ??
      vi.fn().mockResolvedValue({
        kind: 'ok',
        page: {
          items: [MOCK_RULE],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [RecurringModule],
  })
    .overrideProvider(JoseJwtVerifier)
    .useValue(verifier)
    .overrideProvider(RECURRING_RULES_PORT)
    .useValue(port)
    .compile();

  const application = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  registerProblemFilter(application);
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  app = application;

  return { application, port };
}

describe('Recurring Rules E2E HTTP Guard Verification', () => {
  describe('POST /v1/recurring-rules', () => {
    it('answers 401 when Authorization header is missing and does not invoke port', async () => {
      const { application, port } = await createApplication();

      const response = await application.inject({
        method: 'POST',
        url: '/v1/recurring-rules',
        headers: {
          'x-workspace-id': WORKSPACE_ID,
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        payload: VALID_CREATE_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(port.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers 401 when Bearer token is rejected and does not invoke port', async () => {
      const { application, port } = await createApplication();

      const response = await application.inject({
        method: 'POST',
        url: '/v1/recurring-rules',
        headers: {
          authorization: 'Bearer rejected-token',
          'x-workspace-id': WORKSPACE_ID,
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        payload: VALID_CREATE_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(port.createRecurringRule).not.toHaveBeenCalled();
    });

    it('answers 201 with created rule when authenticated and valid', async () => {
      const { application, port } = await createApplication();

      const response = await application.inject({
        method: 'POST',
        url: '/v1/recurring-rules',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-workspace-id': WORKSPACE_ID,
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        payload: VALID_CREATE_BODY,
      });

      expect(response.statusCode).toBe(201);
      expect(port.createRecurringRule).toHaveBeenCalledWith(
        SUBJECT,
        WORKSPACE_ID,
        expect.objectContaining({ name: 'Gym Membership' }),
        IDEMPOTENCY_KEY,
      );
      expect(response.json()).toEqual(MOCK_RULE);
    });
  });

  describe('GET /v1/recurring-rules', () => {
    it('answers 401 when Authorization header is missing and does not invoke port', async () => {
      const { application, port } = await createApplication();

      const response = await application.inject({
        method: 'GET',
        url: '/v1/recurring-rules',
        headers: {
          'x-workspace-id': WORKSPACE_ID,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(port.listRecurringRules).not.toHaveBeenCalled();
    });

    it('answers 401 when Bearer token is rejected and does not invoke port', async () => {
      const { application, port } = await createApplication();

      const response = await application.inject({
        method: 'GET',
        url: '/v1/recurring-rules',
        headers: {
          authorization: 'Bearer rejected-token',
          'x-workspace-id': WORKSPACE_ID,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(port.listRecurringRules).not.toHaveBeenCalled();
    });

    it('answers 200 with list page when authenticated and valid', async () => {
      const { application, port } = await createApplication();

      const response = await application.inject({
        method: 'GET',
        url: '/v1/recurring-rules?limit=10',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-workspace-id': WORKSPACE_ID,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(port.listRecurringRules).toHaveBeenCalledWith(
        SUBJECT,
        expect.objectContaining({ workspaceId: WORKSPACE_ID, limit: 10 }),
      );
      expect(response.json()).toEqual({
        items: [MOCK_RULE],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    });
  });
});
