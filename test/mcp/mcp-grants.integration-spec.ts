// Migration under test: 202609060006_mcp_grants.sql
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

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const owner = '11111111-0000-4000-8000-000000000001';
const other = '22222222-0000-4000-8000-000000000002';
const scopes = [
  'accounts:read',
  'accounts:write',
  'budgets:read',
  'budgets:write',
  'reports:read',
  'reports:write',
  'transactions:read',
  'transactions:write',
  'workspace:admin',
] as const;
const body = (workspaceIds: string[], extra: Record<string, unknown> = {}) => ({
  clientName: 'integration-client',
  scopes: ['accounts:read'],
  workspaceIds,
  ...extra,
});

describe('MCP grants over Fastify HTTP and disposable PostgreSQL', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  let workspace: string;
  let foreignWorkspace: string;
  let account: string;
  let outsideAccount: string;
  const auth = (token = 'owner', key = randomUUID()) => ({
    authorization: `Bearer ${token}`,
    'idempotency-key': key,
  });
  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token = 'owner',
    key = randomUUID(),
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url: path,
      headers: auth(token, key),
      ...(payload === undefined ? {} : { payload }),
    } as never);
  }
  async function create(
    payload: Record<string, unknown> = body([workspace]),
    key = randomUUID(),
    token = 'owner',
  ) {
    return request('POST', '/v1/mcp/grants', token, key, payload);
  }
  async function created(payload: Record<string, unknown> = body([workspace])) {
    const response = await create(payload);
    expect(response.statusCode).toBe(201);
    return JSON.parse(response.payload) as { id: string; createdAt: string };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });
    admin = new Pool({ connectionString: url });
    await admin.query(
      `insert into auth.users (id,email) values ($1,'mcp-owner@test'),($2,'mcp-other@test') on conflict (id) do nothing`,
      [owner, other],
    );
    await admin.query(
      `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,'mcp-owner@test','MCP Owner','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($2,'mcp-other@test','MCP Other','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD') on conflict (id) do nothing`,
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
    account = randomUUID();
    outsideAccount = randomUUID();
    await admin.query(
      `insert into public.workspaces (id,name,kind,base_currency) values ($1,'MCP workspace','shared','USD'),($2,'MCP foreign','shared','USD')`,
      [workspace, foreignWorkspace],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($2,$4,'owner','active')`,
      [workspace, foreignWorkspace, owner, other],
    );
    await admin.query(
      `insert into public.accounts (id,workspace_id,name,type,currency,status,created_by) values ($1,$3,'MCP account','checking','USD','active',$5),($2,$4,'Outside account','checking','USD','active',$5)`,
      [account, outsideAccount, workspace, foreignWorkspace, owner],
    );
  });
  afterEach(async () => {
    await admin.query(
      'delete from public.mcp_grants where subject_id in ($1,$2)',
      [owner, other],
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

  it.each(scopes)('accepts valid scope %s', async (scope) => {
    const response = await create(body([workspace], { scopes: [scope] }));
    expect(response.statusCode).toBe(201);
  });
  it('rejects invalid scope, duplicate scopes, and empty scopes with 422', async () => {
    expect(
      (await create(body([workspace], { scopes: ['invalid:scope'] })))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await create(
          body([workspace], { scopes: ['accounts:read', 'accounts:read'] }),
        )
      ).statusCode,
    ).toBe(422);
    expect((await create(body([workspace], { scopes: [] }))).statusCode).toBe(
      422,
    );
  });
  it('checks every requested workspace and returns 403 when one lacks active membership', async () => {
    const response = await create(body([workspace, foreignWorkspace]));
    expect(response.statusCode).toBe(403);
  });
  it('rejects an account outside the named workspaces with 422', async () => {
    expect(
      (await create(body([workspace], { accountIds: [outsideAccount] })))
        .statusCode,
    ).toBe(422);
  });
  it('rejects unknown top-level properties with 422', async () => {
    const response = await create(body([workspace], { unknown: true }));
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'unknown' })]),
    );
  });
  it('returns 404 for another subject list and revoke, not 403', async () => {
    const grant = await created();
    const list = await request('GET', '/v1/mcp/grants', 'other');
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload).items).toEqual([]);
    const revoke = await request(
      'DELETE',
      `/v1/mcp/grants/${grant.id}`,
      'other',
    );
    expect(revoke.statusCode).toBe(404);
  });
  it('rejects double revoke with 409', async () => {
    const grant = await created();
    expect(
      (await request('DELETE', `/v1/mcp/grants/${grant.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await request('DELETE', `/v1/mcp/grants/${grant.id}`)).statusCode,
    ).toBe(409);
  });
  it('returns 409 when an idempotency key names a different grant', async () => {
    const key = randomUUID();
    const first = await created();
    expect(
      (await request('DELETE', `/v1/mcp/grants/${first.id}`, 'owner', key))
        .statusCode,
    ).toBe(204);
    const second = await created();
    expect(
      (await request('DELETE', `/v1/mcp/grants/${second.id}`, 'owner', key))
        .statusCode,
    ).toBe(409);
  });
  it('treats an expiry at or before the current read clock as expired', async () => {
    const grant = await created({
      ...body([workspace]),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    const response = await request('DELETE', `/v1/mcp/grants/${grant.id}`);
    expect(response.statusCode).toBe(409);
    const list = await request('GET', '/v1/mcp/grants');
    expect(JSON.parse(list.payload).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: grant.id, status: 'expired' }),
      ]),
    );
  });
  it('returns 401 without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/mcp/grants' });
    expect(response.statusCode).toBe(401);
  });
  it('paginates byte-identical timestamps with a stable id tie-break', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const timestamp = '2026-01-01T00:00:00.000000Z';
    for (const id of [ids[1], ids[2], ids[0]])
      await admin.query(
        `insert into public.mcp_grants (id,subject_id,client_name,scopes,workspace_ids,created_at) values ($1,$2,'same-time',array['accounts:read'],array[$3::uuid],$4)`,
        [id, owner, workspace, timestamp],
      );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const response = await request(
        'GET',
        `/v1/mcp/grants?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(response.statusCode).toBe(200);
      const page = JSON.parse(response.payload) as {
        items: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean; nextCursor: string | null };
      };
      seen.push(...page.items.map((item) => item.id));
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});
