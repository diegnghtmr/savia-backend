// Migrations under test: 202609060007_ai_credentials.sql, 202609060015_ai_credential_owner_required.sql
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { CredentialCrypto } from '../../src/platform/credential-crypto.js';
import {
  CommitOutcomeUnknownError,
  PgTransaction,
} from '../../src/platform/pg-transaction.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const owner = '11111111-0000-4000-8000-000000000011';
const other = '22222222-0000-4000-8000-000000000022';

describe('AI credentials over Fastify HTTP and disposable PostgreSQL', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  let workspace: string;
  let foreignWorkspace: string;
  const key = () => randomUUID();
  const headers = (token = 'owner', idempotencyKey = key()) => ({
    authorization: `Bearer ${token}`,
    'x-workspace-id': workspace,
    'idempotency-key': idempotencyKey,
  });
  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    path: string,
    token = 'owner',
    idempotencyKey = key(),
    payload?: unknown,
    workspaceId = workspace,
    ifMatch?: string,
  ) {
    return app.inject({
      method,
      url: path,
      headers: {
        ...headers(token, idempotencyKey),
        'x-workspace-id': workspaceId,
        ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      },
      ...(payload === undefined ? {} : { payload }),
    } as never);
  }
  const createBody = (
    secret = 'sk-secret-1234',
    extra: Record<string, unknown> = {},
  ) => ({
    ownerType: 'user',
    providerId: 'openai',
    credentialType: 'api_key',
    secret,
    alias: 'primary',
    ...extra,
  });

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
      SAVIA_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    admin = new Pool({ connectionString: url });
    await admin.query(
      "insert into auth.users (id,email) values ($1,'ai-owner@test'),($2,'ai-other@test') on conflict (id) do nothing",
      [owner, other],
    );
    await admin.query(
      "insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,'ai-owner@test','AI Owner','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($2,'ai-other@test','AI Other','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD') on conflict (id) do nothing",
      [owner, other],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) =>
          token === 'owner'
            ? { subject: owner }
            : token === 'other'
              ? { subject: other }
              : Promise.reject(new Error('rejected')),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(async () => {
    workspace = randomUUID();
    foreignWorkspace = randomUUID();
    await admin.query(
      "insert into public.workspaces (id,name,kind,base_currency) values ($1,'AI workspace','shared','USD'),($2,'AI foreign','shared','USD')",
      [workspace, foreignWorkspace],
    );
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($2,$4,'owner','active')",
      [workspace, foreignWorkspace, owner, other],
    );
  });
  afterEach(async () => {
    await admin.query(
      'delete from public.ai_default_models where workspace_id in ($1,$2)',
      [workspace, foreignWorkspace],
    );
    await admin.query(
      'delete from public.ai_credentials where workspace_id in ($1,$2)',
      [workspace, foreignWorkspace],
    );
    await admin.query('delete from public.workspaces where id in ($1,$2)', [
      workspace,
      foreignWorkspace,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await admin?.query('delete from auth.users where id in ($1,$2)', [
      owner,
      other,
    ]);
    await admin?.end();
  });

  it('lists providers and credentials with the required workspace header', async () => {
    const providers = await request('GET', '/v1/ai/providers');
    expect(providers.statusCode).toBe(200);
    expect(JSON.parse(providers.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'openai' }),
      ]),
    );
    const credentials = await request('GET', '/v1/ai/credentials');
    expect(credentials.statusCode).toBe(200);
    expect(JSON.parse(credentials.payload)).toEqual([]);
  });
  it('creates, replays, updates, revokes, and returns creator ownership without plaintext', async () => {
    const secret = 'sk-secret-1234';
    const createKey = key();
    const created = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      createKey,
      createBody(secret),
    );
    expect(created.statusCode).toBe(201);
    const metadata = JSON.parse(created.payload) as {
      id: string;
      maskedIdentifier: string;
      ownerSubjectId: string | null;
    };
    expect(metadata.maskedIdentifier).toBe('••••1234');
    expect(metadata.ownerSubjectId).toBe(owner);
    expect(created.payload).not.toContain(secret);
    const replay = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      createKey,
      createBody(secret),
    );
    expect(replay.statusCode).toBe(201);
    expect(JSON.parse(replay.payload).id).toBe(metadata.id);
    expect(
      (
        await request(
          'POST',
          '/v1/ai/credentials',
          'owner',
          createKey,
          createBody('different'),
        )
      ).statusCode,
    ).toBe(409);
    const stored = await admin.query<{ encrypted_secret: string }>(
      'select encrypted_secret from public.ai_credentials where id=$1',
      [metadata.id],
    );
    expect(stored.rows[0].encrypted_secret).not.toBe(secret);
    expect(
      new CredentialCrypto(process.env.SAVIA_CREDENTIAL_KEY).decrypt(
        stored.rows[0].encrypted_secret,
      ),
    ).toBe(secret);
    const updated = await request(
      'PATCH',
      `/v1/ai/credentials/${metadata.id}`,
      'owner',
      key(),
      { alias: 'rotated', replacementSecret: 'new-secret-9999' },
      workspace,
      '"0"',
    );
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.payload).maskedIdentifier).toBe('••••9999');
    const cleared = await request(
      'PATCH',
      `/v1/ai/credentials/${metadata.id}`,
      'owner',
      key(),
      { alias: null },
      workspace,
      '"1"',
    );
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.payload).alias).toBeNull();
    expect(
      (
        await request('PUT', '/v1/ai/default-model', 'owner', key(), {
          modelRef: 'openai:gpt-5',
          credentialId: metadata.id,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          'DELETE',
          `/v1/ai/credentials/${metadata.id}`,
          'owner',
          key(),
        )
      ).statusCode,
    ).toBe(204);
  });
  it('keeps user-owned credentials scoped to one workspace and subject', async () => {
    const created = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      key(),
      createBody('owner-secret'),
    );
    expect(created.statusCode).toBe(201);
    expect(
      JSON.parse(
        (
          await request(
            'GET',
            '/v1/ai/credentials',
            'owner',
            key(),
            undefined,
            foreignWorkspace,
          )
        ).payload,
      ),
    ).toEqual([]);
    expect(
      JSON.parse(
        (
          await request(
            'GET',
            '/v1/ai/credentials',
            'other',
            key(),
            undefined,
            workspace,
          )
        ).payload,
      ),
    ).toEqual([]);
  });
  it('does not expose or update a user-owned credential to a second member', async () => {
    const created = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      key(),
      createBody('owner-secret', { alias: 'private' }),
    );
    const id = JSON.parse(created.payload).id as string;
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active')",
      [workspace, other],
    );
    expect(
      JSON.parse((await request('GET', '/v1/ai/credentials', 'other')).payload),
    ).toEqual([]);
    expect(
      (
        await request(
          'PATCH',
          `/v1/ai/credentials/${id}`,
          'other',
          key(),
          { alias: 'stolen' },
          workspace,
          '"0"',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'PATCH',
          `/v1/ai/credentials/${id}`,
          'other',
          key(),
          { replacementSecret: 'stolen-secret' },
          workspace,
          '"0"',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await request('DELETE', `/v1/ai/credentials/${id}`, 'other')).statusCode,
    ).toBe(404);
    expect(
      (
        await request('PUT', '/v1/ai/default-model', 'other', key(), {
          modelRef: 'openai:gpt-5',
          credentialId: id,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('applies the same RLS boundary to workspace-owned credentials', async () => {
    const created = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      key(),
      createBody('gateway-secret', {
        ownerType: 'workspace',
        providerId: 'openai-compatible',
        credentialType: 'gateway_token',
        alias: 'workspace-key',
      }),
    );
    expect(created.statusCode).toBe(201);
    expect(
      JSON.parse((await request('GET', '/v1/ai/credentials')).payload),
    ).toEqual([
      expect.objectContaining({ ownerType: 'workspace', ownerSubjectId: null }),
    ]);
    expect(
      (
        await request('PUT', '/v1/ai/default-model', 'owner', key(), {
          modelRef: 'openai-compatible:gpt-5',
          credentialId: JSON.parse(created.payload).id,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      JSON.parse(
        (
          await request(
            'GET',
            '/v1/ai/credentials',
            'other',
            key(),
            undefined,
            workspace,
          )
        ).payload,
      ),
    ).toEqual([]);
    expect(
      JSON.parse(
        (
          await request(
            'GET',
            '/v1/ai/credentials',
            'owner',
            key(),
            undefined,
            foreignWorkspace,
          )
        ).payload,
      ),
    ).toEqual([]);
  });
  it('reaches declared validation and conflict statuses', async () => {
    expect(
      (
        await request(
          'POST',
          '/v1/ai/credentials',
          'owner',
          key(),
          createBody('x', { credentialType: 'oauth' }),
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await request('PUT', '/v1/ai/default-model', 'owner', key(), {
          modelRef: 'anthropic:claude-sonnet',
          credentialId: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('rejects orphaned user credentials at the database constraint', async () => {
    await expect(
      admin.query(
        "insert into public.ai_credentials (id,workspace_id,owner_type,provider_id,credential_type,encrypted_secret,masked_identifier) values ($1,$2,'user','openai','api_key','cipher','••••')",
        [randomUUID(), workspace],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ai_credentials_owner_required',
    });
  });
  it('maps a duplicate alias during update to 409', async () => {
    const first = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      key(),
      createBody('first-secret', { alias: 'first' }),
    );
    expect(first.statusCode).toBe(201);
    const second = await request(
      'POST',
      '/v1/ai/credentials',
      'owner',
      key(),
      createBody('second-secret', { alias: 'second' }),
    );
    expect(second.statusCode).toBe(201);
    const response = await request(
      'PATCH',
      `/v1/ai/credentials/${JSON.parse(second.payload).id}`,
      'owner',
      key(),
      { alias: 'first' },
      workspace,
      '"0"',
    );
    expect(response.statusCode).toBe(409);
  });
  it('maps an AI write commit acknowledgement failure to declared 503', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({ verify: async () => ({ subject: owner }) })
      .overrideProvider(PgTransaction)
      .useValue({
        run: async () => {
          throw new CommitOutcomeUnknownError(
            new Error('connection reset by peer'),
          );
        },
        runRead: async () => [],
      })
      .compile();
    const failureApp = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(failureApp);
    await failureApp.init();
    await failureApp.getHttpAdapter().getInstance().ready();
    const response = await failureApp.inject({
      method: 'POST',
      url: '/v1/ai/credentials',
      headers: {
        authorization: 'Bearer owner',
        'x-workspace-id': workspace,
        'idempotency-key': key(),
      },
      payload: createBody(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.payload).not.toContain('sk-secret-1234');
    await failureApp.close();
  });
});
