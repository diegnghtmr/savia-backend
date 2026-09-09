// Migration under test: 202609060010_cli_device_authorize.sql
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
describe('CLI device authorization', () => {
  let pool: Pool;
  let app: NestFastifyApplication;
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
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = ref.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  it('authorizes without JWT and persists only a digest', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/authorize',
      payload: { clientId: 'integration-cli', scopes: ['read'] },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    };
    expect(body).toMatchObject({
      verificationUri: 'https://app.example.test/device',
      expiresIn: 600,
      interval: 5,
    });
    expect(body.deviceCode).not.toContain(body.userCode);
    const row = await pool.query<{ device_code_hash: string }>(
      'select device_code_hash from public.cli_device_authorizations where user_code = $1',
      [body.userCode],
    );
    expect(row.rows[0]?.device_code_hash).not.toBe(body.deviceCode);
  });
  it('uses 400 for malformed requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/authorize',
      payload: { scopes: [] },
    });
    expect(response.statusCode).toBe(400);
  });
});
