// Migration under test: 202609060010_cli_device_authorize.sql
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const subject = '00000000-0000-0000-0000-000000000201';
describe('CLI device authorization', () => {
  let pool: Pool;
  let app: NestFastifyApplication;
  const jwtVerifier = { verify: vi.fn() };
  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
      SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
      CLI_DEVICE_VERIFICATION_URI: 'https://app.example.test/device',
    });
    pool = new Pool({ connectionString: url });
    await pool.query(
      `insert into auth.users (id, email) values ($1, $2)
       on conflict (id) do nothing`,
      [subject, 'cli-approval@example.test'],
    );
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue(jwtVerifier)
      .compile();
    app = ref.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  function authorizationPayload(clientId: string, scopes: string[] = []) {
    return { clientId, scopes };
  }

  function decode(response: { payload: string }) {
    return JSON.parse(response.payload) as Record<string, unknown>;
  }

  async function authorize(
    clientId: string,
    scopes: string[] = [],
    options: { authorization?: string; remoteAddress?: string } = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/cli/device/authorize',
      ...(options.authorization === undefined
        ? {}
        : { headers: { authorization: options.authorization } }),
      ...(options.remoteAddress === undefined
        ? {}
        : { remoteAddress: options.remoteAddress }),
      payload: authorizationPayload(clientId, scopes),
    });
  }

  it('authorizes without JWT and persists only a SHA-256 digest', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/authorize',
      payload: authorizationPayload('integration-cli-hash', ['read']),
    });
    expect(response.statusCode).toBe(200);
    const body = decode(response) as {
      deviceCode: string;
      userCode: string;
    } & Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'deviceCode',
      'expiresIn',
      'interval',
      'userCode',
      'verificationUri',
    ]);
    expect(
      typeof body.deviceCode === 'string' && body.deviceCode.length > 0,
    ).toBe(true);
    expect(
      typeof body.userCode === 'string' &&
        /^[A-HJ-NP-Z2-9]{8}$/.test(body.userCode),
    ).toBe(true);
    expect(body.verificationUri).toBe('https://app.example.test/device');
    expect(
      typeof body.expiresIn === 'number' &&
        body.expiresIn >= 1 &&
        Number.isInteger(body.expiresIn),
    ).toBe(true);
    expect(
      typeof body.interval === 'number' &&
        body.interval >= 1 &&
        Number.isInteger(body.interval),
    ).toBe(true);
    const row = await pool.query<{ device_code_hash: string }>(
      'select device_code_hash from public.cli_device_authorizations where user_code = $1',
      [body.userCode],
    );
    const stored = row.rows[0]?.device_code_hash;
    const digest = createHash('sha256').update(body.deviceCode).digest('hex');
    expect(typeof stored === 'string' && stored !== body.deviceCode).toBe(true);
    expect(stored === digest).toBe(true);
  });

  it('ignores a bearer token because the route is deliberately unauthenticated', async () => {
    const response = await authorize('integration-cli-bearer', [], {
      authorization: 'Bearer definitely-not-a-valid-token',
    });
    expect(response.statusCode).toBe(200);
  });

  it('uses a fresh CSPRNG value for every authorization response', async () => {
    const first = decode(await authorize('integration-cli-random-1'));
    const second = decode(await authorize('integration-cli-random-2'));
    expect(first.deviceCode === second.deviceCode).toBe(false);
    expect(first.userCode === second.userCode).toBe(false);
  });

  it.each([
    ['missing clientId', {}, 'clientId'],
    ['non-string clientId', { clientId: 123 }, 'clientId'],
    [
      'duplicate scopes',
      { clientId: 'invalid', scopes: ['read', 'read'] },
      'scopes',
    ],
    ['non-array scopes', { clientId: 'invalid', scopes: 'read' }, 'scopes'],
    [
      'unknown top-level key',
      { clientId: 'invalid', unexpected: true },
      'unexpected',
    ],
  ])(
    'returns 400 and identifies the %s field',
    async (_name, payload, field) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/cli/device/authorize',
        payload,
      });
      expect(response.statusCode).toBe(400);
      const body = decode(response) as { errors?: { field: string }[] };
      expect(body.errors?.some((violation) => violation.field === field)).toBe(
        true,
      );
    },
  );

  it('allows ten requests per client and peer IP, then returns 429', async () => {
    const clientId = 'integration-cli-rate-limit';
    const results = [];
    for (let attempt = 0; attempt < 11; attempt++)
      results.push(
        await authorize(clientId, [], { remoteAddress: '198.51.100.10' }),
      );
    expect(
      results.slice(0, 10).every((result) => result.statusCode === 200),
    ).toBe(true);
    expect(results[10]?.statusCode).toBe(429);
  });

  it('scopes rate limits by client ID and peer IP', async () => {
    const sameIpClient = 'integration-cli-rate-other-client';
    const differentIpClient = 'integration-cli-rate-other-ip';
    const sameIp = await authorize(sameIpClient, [], {
      remoteAddress: '198.51.100.10',
    });
    const differentIp = await authorize('integration-cli-rate-limit', [], {
      remoteAddress: '198.51.100.11',
    });
    const differentIpAgain = await authorize(differentIpClient, [], {
      remoteAddress: '198.51.100.11',
    });
    expect(sameIp.statusCode).toBe(200);
    expect(differentIp.statusCode).toBe(200);
    expect(differentIpAgain.statusCode).toBe(200);
  });

  it('persists an expiry after creation for the bounded authorization lifetime', async () => {
    const response = await authorize('integration-cli-expiry');
    expect(response.statusCode).toBe(200);
    const body = decode(response) as { userCode: string };
    const row = await pool.query<{ created_at: string; expires_at: string }>(
      'select created_at, expires_at from public.cli_device_authorizations where user_code = $1',
      [body.userCode],
    );
    const created = Date.parse(row.rows[0]?.created_at ?? '');
    const expires = Date.parse(row.rows[0]?.expires_at ?? '');
    expect(Number.isFinite(created) && Number.isFinite(expires)).toBe(true);
    expect(expires - created).toBe(600_000);
    expect(expires > created).toBe(true);
  });

  it('buckets rate limits in UTC regardless of the database session timezone', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("set local timezone to 'Asia/Kathmandu'");
      await client.query(
        `select public.consume_cli_device_rate_limit(
          'integration-cli-timezone', '198.51.100.12'::inet,
          '1900-01-01T00:00:30Z'::timestamptz
        )`,
      );
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count
         from public.cli_device_rate_limits
         where client_id = 'integration-cli-timezone' and ip = '198.51.100.12'
           and window_start = '1900-01-01T00:00:00Z'::timestamptz`,
      );
      expect(result.rows[0]?.count).toBe('1');
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('approves a device with a session, supports same-subject replay, and issues a token', async () => {
    jwtVerifier.verify.mockReset().mockResolvedValue({
      subject,
      authMethod: 'session',
    });
    const authorization = decode(
      await authorize('integration-cli-approval'),
    ) as {
      deviceCode: string;
      userCode: string;
    };
    const approved = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/approve',
      headers: { authorization: 'Bearer session-token' },
      payload: { userCode: authorization.userCode.toLowerCase() },
    });
    expect(approved.statusCode).toBe(204);
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/approve',
      headers: { authorization: 'Bearer session-token' },
      payload: { userCode: authorization.userCode },
    });
    expect(replay.statusCode).toBe(204);
    const token = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: {
        clientId: 'integration-cli-approval',
        deviceCode: authorization.deviceCode,
      },
    });
    expect(token.statusCode).toBe(200);
    expect(decode(token).expiresIn).toBe(2592000);
    const cliApproval = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/approve',
      headers: {
        authorization: `Bearer ${decode(token).accessToken as string}`,
      },
      payload: { userCode: authorization.userCode },
    });
    expect(cliApproval.statusCode).toBe(403);
  });
});
