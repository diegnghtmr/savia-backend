// Migration under test: 202609060008_agent_conversations.sql
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
const owner = '11111111-0000-4000-8000-000000000031';
const member = '22222222-0000-4000-8000-000000000032';

describe('agent conversations over Fastify HTTP and disposable PostgreSQL', () => {
  let admin: Pool;
  let app: NestFastifyApplication;
  let workspace: string;
  let foreignWorkspace: string;
  const key = () => randomUUID();
  const headers = (
    token = 'owner',
    idempotencyKey = key(),
    workspaceId = workspace,
  ) => ({
    authorization: `Bearer ${token}`,
    'x-workspace-id': workspaceId,
    'idempotency-key': idempotencyKey,
  });
  async function request(
    method: 'GET' | 'POST',
    path: string,
    token = 'owner',
    idempotencyKey = key(),
    payload?: unknown,
    workspaceId = workspace,
  ) {
    return app.inject({
      method,
      url: path,
      headers: headers(token, idempotencyKey, workspaceId),
      ...(payload === undefined ? {} : { payload }),
    } as never);
  }
  async function create(
    payload: unknown = {},
    idempotencyKey = key(),
    token = 'owner',
    workspaceId = workspace,
  ) {
    return request(
      'POST',
      '/v1/agent/conversations',
      token,
      idempotencyKey,
      payload,
      workspaceId,
    );
  }
  async function createConversation(payload: unknown = {}) {
    const response = await create(payload);
    expect(response.statusCode).toBe(201);
    return JSON.parse(response.payload) as {
      id: string;
      title: string;
      modelRef: string | null;
      createdAt: string;
    };
  }

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
      "insert into auth.users (id,email) values ($1,'agent-owner@test'),($2,'agent-member@test') on conflict (id) do nothing",
      [owner, member],
    );
    await admin.query(
      "insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency) values ($1,'agent-owner@test','Agent Owner','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD'),($2,'agent-member@test','Agent Member','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD') on conflict (id) do nothing",
      [owner, member],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) =>
          token === 'owner'
            ? { subject: owner }
            : token === 'member'
              ? { subject: member }
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
      "insert into public.workspaces (id,name,kind,base_currency) values ($1,'Agent workspace','shared','USD'),($2,'Agent foreign','shared','USD')",
      [workspace, foreignWorkspace],
    );
    await admin.query(
      "insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($2,$3,'owner','active'),($1,$4,'viewer','active')",
      [workspace, foreignWorkspace, owner, member],
    );
  });
  afterEach(async () => {
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
      member,
    ]);
    await admin?.end();
  });

  it('creates empty, null, empty-string, and unconstrained modelRef requests', async () => {
    expect((await createConversation({})).title).toBe('New conversation');
    expect((await createConversation({ title: null })).title).toBe(
      'New conversation',
    );
    expect((await createConversation({ title: '' })).title).toBe('');
    expect(
      (await createConversation({ modelRef: 'not a provider ref' })).modelRef,
    ).toBe('not a provider ref');
  });
  it('returns 422 without leaking credential existence, workspace, or status', async () => {
    const unknown = await create({ credentialId: randomUUID() });
    expect(unknown.statusCode).toBe(422);
    const foreignCredential = randomUUID();
    await admin.query(
      "insert into public.ai_credentials (id,workspace_id,owner_type,provider_id,credential_type,encrypted_secret,masked_identifier,status) values ($1,$2,'workspace','openai','api_key','cipher','••••','active')",
      [foreignCredential, foreignWorkspace],
    );
    const foreign = await create({ credentialId: foreignCredential });
    expect(foreign.statusCode).toBe(422);
    const revoked = randomUUID();
    await admin.query(
      "insert into public.ai_credentials (id,workspace_id,owner_type,provider_id,credential_type,encrypted_secret,masked_identifier,status) values ($1,$2,'workspace','openai','api_key','cipher','••••','revoked')",
      [revoked, workspace],
    );
    const revokedResponse = await create({ credentialId: revoked });
    expect(revokedResponse.statusCode).toBe(422);
    expect(JSON.parse(unknown.payload)).toEqual(
      expect.objectContaining({ status: 422 }),
    );
    expect(JSON.parse(foreign.payload)).toMatchObject({
      type: JSON.parse(unknown.payload).type,
      title: JSON.parse(unknown.payload).title,
      status: 422,
    });
    expect(JSON.parse(revokedResponse.payload)).toMatchObject({
      type: JSON.parse(unknown.payload).type,
      title: JSON.parse(unknown.payload).title,
      status: 422,
    });
  });
  it('replays idempotent create and conflicts on changed payload', async () => {
    const idempotencyKey = key();
    const first = await create({ title: 'same' }, idempotencyKey);
    const replay = await create({ title: 'same' }, idempotencyKey);
    const conflict = await create({ title: 'different' }, idempotencyKey);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(JSON.parse(replay.payload).id).toBe(JSON.parse(first.payload).id);
    expect(conflict.statusCode).toBe(409);
    expect(
      (
        await admin.query(
          'select count(*)::int as count from public.agent_conversations where workspace_id=$1',
          [workspace],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it('keeps conversations visible to a second workspace member but not a foreign workspace', async () => {
    const conversation = await createConversation({ title: 'shared' });
    const memberList = await request(
      'GET',
      '/v1/agent/conversations',
      'member',
    );
    const foreignList = await request(
      'GET',
      '/v1/agent/conversations',
      'owner',
      key(),
      undefined,
      foreignWorkspace,
    );
    expect(memberList.statusCode).toBe(200);
    expect(JSON.parse(memberList.payload).items).toEqual([
      expect.objectContaining({ id: conversation.id }),
    ]);
    expect(JSON.parse(foreignList.payload).items).toEqual([]);
  });
  it('paginates three byte-identical timestamps exactly once in id order', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const timestamp = '2026-01-01T00:00:00.000000Z';
    for (const id of [ids[1], ids[2], ids[0]])
      await admin.query(
        "insert into public.agent_conversations (id,workspace_id,created_by_subject_id,title,created_at,updated_at) values ($1,$2,$3,'tie',$4,$4)",
        [id, workspace, owner, timestamp],
      );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(
        'GET',
        `/v1/agent/conversations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
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
    expect(seen).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(3);
  });
  it('returns 401 without a token', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/agent/conversations' }))
        .statusCode,
    ).toBe(401);
  });
});
