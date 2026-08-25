import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import {
  BOOTSTRAP_PORT,
  type BootstrapPort,
} from '../src/identity/bootstrap.port.js';
import {
  PROFILE_PORT,
  type ProfilePort,
} from '../src/identity/profile.port.js';
import {
  WORKSPACE_PORT,
  type WorkspacePort,
} from '../src/identity/workspace.port.js';
import { JoseJwtVerifier } from '../src/identity/jose-jwt-verifier.js';
import { registerProblemFilter } from '../src/identity/onboarding-problem.filter.js';

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
}

interface OpenApiDocument {
  openapi: string;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
  };
}

const TEST_SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const TEST_TOKEN = 'accepted-token';
const TEST_AGGREGATE = {
  profileId: TEST_SUBJECT,
  workspaceId: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
} as const;

const VALID_ONBOARDING_BODY = {
  email: 'person@example.com',
  displayName: 'Ada Lovelace',
  locale: 'en-US',
  countryCode: 'co',
  timezone: 'America/Bogota',
  dateFormat: 'YYYY-MM-DD',
  weekStartsOn: 1,
  numberFormat: '1,234.56',
  defaultCurrency: 'cop',
  workspaceName: 'Personal',
  baseCurrency: 'cop',
  privacyModeEnabled: false,
} as const;

const authEnvironment = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
} as const;

const authEnvironmentKeys = Object.keys(authEnvironment);
let originalEnvironment: Record<string, string | undefined>;
let originalDatabaseUrl: string | undefined;

// Bundling shells out to redocly, and every one of this suite's tests used to pay
// for its own child process. That cost scales with the contract, so each published
// operation made the whole file slower until a test crossed the 5s budget --
// operation 17 is what tipped it over on CI.
//
// The BYTES are cached, not the parsed object: Ajv.addSchema may annotate the
// schemas it is handed, so every caller still gets a pristine document. The
// contract file cannot change mid-run, so one bundle is equivalent to twelve.
let bundledContractJson: string | undefined;

function loadBundledContract(): OpenApiDocument {
  if (bundledContractJson === undefined) {
    const root = process.cwd();
    const contractPath = 'openapi/savia.openapi.yaml';
    const directory = mkdtempSync(join(tmpdir(), 'savia-openapi-response-'));
    const output = join(directory, 'contract.json');

    try {
      execFileSync(
        resolve(root, 'node_modules/.bin/redocly'),
        [
          'bundle',
          resolve(root, contractPath),
          '--ext',
          'json',
          '--output',
          output,
        ],
        { cwd: root, stdio: 'pipe' },
      );
      bundledContractJson = readFileSync(output, 'utf8');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }

  return JSON.parse(bundledContractJson) as OpenApiDocument;
}

function compileResponseValidator(
  document: OpenApiDocument,
  path: string,
  method: string,
  statusCode: string,
  contentType = 'application/json',
): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);

  for (const [name, schema] of Object.entries(
    document.components?.schemas ?? {},
  )) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }

  const operation = document.paths?.[path]?.[method.toLowerCase()];
  const response = operation?.responses?.[statusCode];
  const schema = response?.content?.[contentType]?.schema;

  if (schema === undefined) {
    throw new Error(
      `No JSON response schema found for ${method.toUpperCase()} ${path} ${statusCode}`,
    );
  }

  return ajv.compile(schema);
}

describe('OpenAPI runtime response-schema conformance (TRD §42 rule 11)', () => {
  let app: NestFastifyApplication | undefined;

  beforeEach(() => {
    originalEnvironment = Object.fromEntries(
      authEnvironmentKeys.map((key) => [key, process.env[key]]),
    );
    originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    Object.assign(process.env, authEnvironment);
  });

  afterEach(async () => {
    for (const key of authEnvironmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;

    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  async function createApplication(overrides?: {
    deleteOp?: WorkspacePort['delete'];
  }): Promise<NestFastifyApplication> {
    const bootstrapMock: BootstrapPort = {
      execute: vi.fn<BootstrapPort['execute']>().mockResolvedValue({
        kind: 'created',
        aggregate: TEST_AGGREGATE,
      }),
    };
    const profileMock: ProfilePort = {
      read: vi.fn<ProfilePort['read']>().mockResolvedValue(undefined),
      update: vi.fn<ProfilePort['update']>().mockResolvedValue({
        kind: 'version-conflict',
      }),
    };
    const workspaceMock: WorkspacePort = {
      read: vi.fn<WorkspacePort['read']>().mockResolvedValue({
        kind: 'not-found',
      }),
      list: vi.fn<WorkspacePort['list']>().mockResolvedValue({
        items: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      }),
      create: vi.fn<WorkspacePort['create']>().mockResolvedValue({
        kind: 'created',
        workspace: {
          id: TEST_AGGREGATE.workspaceId,
          name: 'Acme Family',
          kind: 'family',
          baseCurrency: 'USD',
          role: 'owner',
          createdAt: '2026-07-15T00:00:00.000Z',
          version: 1,
        },
      }),
      update: vi.fn<WorkspacePort['update']>().mockResolvedValue({
        kind: 'version-conflict',
      }),
      delete:
        overrides?.deleteOp ??
        vi.fn<WorkspacePort['delete']>().mockResolvedValue({
          kind: 'not-found',
        }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: (token: string) =>
          token === TEST_TOKEN
            ? Promise.resolve({ subject: TEST_SUBJECT })
            : Promise.reject(new Error('token rejected')),
      })
      .overrideProvider(BOOTSTRAP_PORT)
      .useValue(bootstrapMock)
      .overrideProvider(PROFILE_PORT)
      .useValue(profileMock)
      .overrideProvider(WORKSPACE_PORT)
      .useValue(workspaceMock)
      .compile();

    const fastifyApp = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(fastifyApp);
    await fastifyApp.init();
    await fastifyApp.getHttpAdapter().getInstance().ready();
    return fastifyApp;
  }

  it('validates live GET /health response body against its declared 200 schema', async () => {
    const document = loadBundledContract();
    const validateHealthResponse = compileResponseValidator(
      document,
      '/health',
      'GET',
      '200',
    );

    app = await createApplication();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload);

    const isValid = validateHealthResponse(payload);
    expect(validateHealthResponse.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live POST /v1/onboarding response body against its declared 201 schema', async () => {
    const document = loadBundledContract();
    const validateOnboardingResponse = compileResponseValidator(
      document,
      '/v1/onboarding',
      'POST',
      '201',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/onboarding',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: VALID_ONBOARDING_BODY,
    });

    expect(response.statusCode).toBe(201);
    const payload = JSON.parse(response.payload);

    const isValid = validateOnboardingResponse(payload);
    expect(validateOnboardingResponse.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live GET /v1/me 404 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validateProfileNotFound = compileResponseValidator(
      document,
      '/v1/me',
      'GET',
      '404',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.payload);

    const isValid = validateProfileNotFound(payload);
    expect(validateProfileNotFound.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live PATCH /v1/me 412 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validatePreconditionFailed = compileResponseValidator(
      document,
      '/v1/me',
      'PATCH',
      '412',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'if-match': '"1"',
      },
      payload: { displayName: 'Ada Lovelace' },
    });

    expect(response.statusCode).toBe(412);
    const payload = JSON.parse(response.payload);

    const isValid = validatePreconditionFailed(payload);
    expect(validatePreconditionFailed.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live PATCH /v1/me 422 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validateUnprocessable = compileResponseValidator(
      document,
      '/v1/me',
      'PATCH',
      '422',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    const payload = JSON.parse(response.payload);

    const isValid = validateUnprocessable(payload);
    expect(validateUnprocessable.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live PATCH /v1/workspaces/{workspaceId} 412 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validatePreconditionFailed = compileResponseValidator(
      document,
      '/v1/workspaces/{workspaceId}',
      'PATCH',
      '412',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${TEST_AGGREGATE.workspaceId}`,
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'if-match': '"1"',
      },
      payload: { name: 'Acme Renovated' },
    });

    expect(response.statusCode).toBe(412);
    const payload = JSON.parse(response.payload);

    const isValid = validatePreconditionFailed(payload);
    expect(validatePreconditionFailed.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live PATCH /v1/workspaces/{workspaceId} 422 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validateUnprocessable = compileResponseValidator(
      document,
      '/v1/workspaces/{workspaceId}',
      'PATCH',
      '422',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${TEST_AGGREGATE.workspaceId}`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    const payload = JSON.parse(response.payload);

    const isValid = validateUnprocessable(payload);
    expect(validateUnprocessable.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live POST /v1/workspaces response body against its declared 201 schema', async () => {
    const document = loadBundledContract();
    const validateWorkspaceResponse = compileResponseValidator(
      document,
      '/v1/workspaces',
      'POST',
      '201',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'idempotency-key': '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01',
      },
      payload: {
        name: 'Acme Family',
        kind: 'family',
        baseCurrency: 'USD',
      },
    });

    expect(response.statusCode).toBe(201);
    const payload = JSON.parse(response.payload);

    const isValid = validateWorkspaceResponse(payload);
    expect(validateWorkspaceResponse.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live POST /v1/workspaces 422 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validateUnprocessable = compileResponseValidator(
      document,
      '/v1/workspaces',
      'POST',
      '422',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'idempotency-key': '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01',
      },
      payload: {
        name: 'Invalid',
        kind: 'personal',
        baseCurrency: 'USD',
      },
    });

    expect(response.statusCode).toBe(422);
    const payload = JSON.parse(response.payload);

    const isValid = validateUnprocessable(payload);
    expect(validateUnprocessable.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live DELETE /v1/workspaces/{workspaceId} 404 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validateNotFound = compileResponseValidator(
      document,
      '/v1/workspaces/{workspaceId}',
      'DELETE',
      '404',
      'application/problem+json',
    );

    app = await createApplication();
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${TEST_AGGREGATE.workspaceId}`,
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'idempotency-key': '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01',
      },
    });

    expect(response.statusCode).toBe(404);
    const payload = JSON.parse(response.payload);

    const isValid = validateNotFound(payload);
    expect(validateNotFound.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates live DELETE /v1/workspaces/{workspaceId} 422 response body against its declared ProblemDetails schema', async () => {
    const document = loadBundledContract();
    const validateUnprocessable = compileResponseValidator(
      document,
      '/v1/workspaces/{workspaceId}',
      'DELETE',
      '422',
      'application/problem+json',
    );

    app = await createApplication({
      deleteOp: async () => ({ kind: 'unprocessable' }),
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${TEST_AGGREGATE.workspaceId}`,
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'idempotency-key': '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01',
      },
    });

    expect(response.statusCode).toBe(422);
    const payload = JSON.parse(response.payload);
    const isValid = validateUnprocessable(payload);
    expect(validateUnprocessable.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('proves the validator rejects non-conforming mutated payloads', () => {
    const document = loadBundledContract();
    const validateHealthResponse = compileResponseValidator(
      document,
      '/health',
      'GET',
      '200',
    );
    const validateOnboardingResponse = compileResponseValidator(
      document,
      '/v1/onboarding',
      'POST',
      '201',
    );
    const validateWorkspaceResponse = compileResponseValidator(
      document,
      '/v1/workspaces',
      'POST',
      '201',
    );

    // Health mutation 1: drop required field 'time'
    const invalidHealthMissingTime = { status: 'ok' };
    expect(validateHealthResponse(invalidHealthMissingTime)).toBe(false);
    expect(validateHealthResponse.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'required',
          params: { missingProperty: 'time' },
        }),
      ]),
    );

    // Health mutation 2: violate 2020-12 const keyword ('ok')
    const invalidHealthConstViolation = {
      status: 'degraded',
      time: new Date().toISOString(),
    };
    expect(validateHealthResponse(invalidHealthConstViolation)).toBe(false);
    expect(validateHealthResponse.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'const',
          params: { allowedValue: 'ok' },
        }),
      ]),
    );

    // Onboarding mutation 1: drop required field 'workspaceId'
    const invalidOnboardingMissingField = { profileId: TEST_SUBJECT };
    expect(validateOnboardingResponse(invalidOnboardingMissingField)).toBe(
      false,
    );
    expect(validateOnboardingResponse.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'required',
          params: { missingProperty: 'workspaceId' },
        }),
      ]),
    );

    // Onboarding mutation 2: wrong type / invalid uuid format
    const invalidOnboardingBadUuid = {
      profileId: 'not-a-valid-uuid',
      workspaceId: 12345,
    };
    expect(validateOnboardingResponse(invalidOnboardingBadUuid)).toBe(false);
    expect(validateOnboardingResponse.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'format',
          params: { format: 'uuid' },
        }),
        expect.objectContaining({
          keyword: 'type',
          params: { type: 'string' },
        }),
      ]),
    );

    // Workspace mutation 1: drop required field 'version'
    const invalidWorkspaceMissingVersion = {
      id: '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d',
      name: 'Acme',
      kind: 'family',
      baseCurrency: 'USD',
      role: 'owner',
      createdAt: '2026-07-15T00:00:00.000Z',
    };
    expect(validateWorkspaceResponse(invalidWorkspaceMissingVersion)).toBe(
      false,
    );
    expect(validateWorkspaceResponse.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'required',
          params: { missingProperty: 'version' },
        }),
      ]),
    );
  });
});
