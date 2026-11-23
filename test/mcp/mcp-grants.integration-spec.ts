// Migrations under test: 202609060006_mcp_grants.sql, 202609060014_mcp_grant_minting_policy.sql, 202609170015_mcp_grant_enforcement.sql
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
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
import { PostgresMcpGrantAdapter } from '../../src/mcp/postgres-mcp-grant.adapter.js';
import type { McpGrant, McpGrantCall } from '../../src/mcp/mcp-grant.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { mcpTokens } from '../helpers/mcp-jwt.js';

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
  let signed: Awaited<ReturnType<typeof mcpTokens>>;
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
    signed = await mcpTokens();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verifyProposal: (token: string) =>
          signed.verifier.verifyProposal(token),
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
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$3,'owner','active'),($1,$4,'owner','active'),($2,$4,'owner','active')`,
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

  const fullWeek = Array.from({ length: 7 }, (_, day) => ({
    dayOfWeek: day + 1,
    startTime: '00:00',
    endTime: '24:00',
  }));
  async function beginActor(client: PoolClient, subject = owner) {
    await client.query('begin');
    await client.query('set local role savia_application');
    await client.query('select set_config($1, $2, true)', [
      'app.subject_id',
      subject,
    ]);
  }
  const adapter = new PostgresMcpGrantAdapter();
  const transferCall = (
    grantId: string,
    accountIds: readonly string[],
  ): McpGrantCall => ({
    grantId,
    subject: owner,
    workspaceId: workspace,
    toolName: 'create_transfer',
    accountIds,
    amounts: [{ amountMinor: '9007199254740993', currency: 'USD' }],
  });
  const authorize = (client: PoolClient, call: McpGrantCall) =>
    adapter.authorizeMcpGrant(client as unknown as TransactionClient, call);

  describe('same-resource MCP reads (L17)', () => {
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();
    const read = (path: string, token: string, workspaceId = workspace) =>
      app.inject({
        method: 'GET',
        url: path,
        headers: { ...auth(token), 'x-workspace-id': workspaceId },
      });
    const grantForRead = async (extra: Record<string, unknown> = {}) =>
      (
        await created(
          body([workspace], {
            schedule: fullWeek,
            expiresAt: expires,
            ...extra,
          }),
        )
      ).id;
    const assertDenied = (
      response: { statusCode: number; json(): unknown },
      status: 401 | 403,
    ) => {
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        status,
        title: status === 401 ? 'Authentication is required' : 'Forbidden',
      });
      expect(response.json()).not.toHaveProperty('items');
    };

    it('admits the bound grant in its workspace and rechecks revocation on the same token', async () => {
      const id = await grantForRead({ toolAllowlist: ['list_accounts'] });
      const token = await signed.sign(owner, id);
      const path = '/v1/accounts';
      const result = await read(path, token);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual((await read(path, 'owner')).json());
      assertDenied(await read(path, token, foreignWorkspace), 403);
      assertDenied(await read('/v1/accounts/' + account, token), 401);
      assertDenied(await read('/v1/approvals', token), 401);
      expect((await request('DELETE', `/v1/mcp/grants/${id}`)).statusCode).toBe(
        204,
      );
      assertDenied(await read(path, token), 403);
    });

    it('distinguishes invalid authentication from a valid token with insufficient grants', async () => {
      const path = '/v1/accounts';
      const id = await grantForRead();
      const missingScope = await grantForRead({
        scopes: ['transactions:read'],
      });
      const wrongTool = await grantForRead({
        toolAllowlist: ['get_account_balance'],
      });
      const unscheduled = await grantForRead({ schedule: [] });
      const expired = await grantForRead();
      await admin.query(
        'update public.mcp_grants set expires_at = now() where id = $1',
        [expired],
      );
      for (const token of [
        await signed.sign(owner),
        await signed.sign(owner, 'not-a-uuid'),
        await signed.sign(owner, id, { aud: 'different-api' }),
        await signed.sign(owner, id, {
          aud: ['savia-api', 'https://api.example.test/mcp-proposals'],
        }),
        await signed.sign(owner, id, { exp: 1 }),
      ])
        assertDenied(await read(path, token), 401);
      for (const token of [
        await signed.sign(other, id),
        await signed.sign(owner, randomUUID()),
        await signed.sign(owner, missingScope),
        await signed.sign(owner, wrongTool),
        await signed.sign(owner, unscheduled),
        await signed.sign(owner, expired),
      ])
        assertDenied(await read(path, token), 403);
    });

    it('filters workspace discovery before pagination and never widens account grants', async () => {
      const id = await grantForRead({ accountIds: [account] });
      const token = await signed.sign(owner, id);
      await admin.query(
        `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active')`,
        [foreignWorkspace, owner],
      );
      await admin.query(
        `update public.workspaces set created_at = now() - interval '1 day' where id = $1`,
        [foreignWorkspace],
      );
      const result = await read('/v1/workspaces?limit=1', token);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        items: [{ id: workspace }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
      const balanceUrl = `/v1/accounts/${account}/balance?asOf=2026-01-02T00:00:00Z`;
      const balance = await read(balanceUrl, token);
      expect(balance.statusCode).toBe(200);
      expect(balance.json()).toEqual((await read(balanceUrl, 'owner')).json());
      const deniedAccount = randomUUID();
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
         values ($1, $2, 'Unlisted account', 'checking', 'USD', 'active', $3)`,
        [deniedAccount, workspace, owner],
      );
      assertDenied(
        await read(`/v1/accounts/${deniedAccount}/balance`, token),
        403,
      );
      assertDenied(await read('/v1/accounts', token), 403);
    });
  });

  it('round-trips grant fields on create, replay and list; omitted restrictions are empty', async () => {
    const defaultGrant = await create();
    expect(defaultGrant.statusCode).toBe(201);
    expect(defaultGrant.json()).toMatchObject({
      toolAllowlist: [],
      schedule: [],
    });
    const key = randomUUID();
    const restrictions = {
      toolAllowlist: ['create_transfer'],
      schedule: fullWeek,
    };
    const payload = body([workspace], restrictions);
    const response = await create(payload, key);
    expect(response.statusCode).toBe(201);
    const grant = response.json<McpGrant>();
    expect(grant).toMatchObject(restrictions);
    expect((await create(payload, key)).json()).toEqual(grant);
    const list = await request('GET', '/v1/mcp/grants');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      items: [defaultGrant.json(), grant],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
  });

  it('returns validation problems without inserting a grant or reserving the idempotency key', async () => {
    const key = randomUUID();
    const invalid = await create(
      body([workspace], {
        toolAllowlist: ['not_a_tool'],
        schedule: [{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }],
      }),
      key,
    );
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      title: 'MCP grant validation failed',
      status: 422,
      errors: [
        { field: 'schedule', code: 'invalid-value' },
        { field: 'toolAllowlist', code: 'unsupported' },
      ],
    });
    expect((await request('GET', '/v1/mcp/grants')).json()).toEqual({
      items: [],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    expect((await create(body([workspace]), key)).statusCode).toBe(201);
  });

  it('enforces subject, current role and membership, grant workspace, every account, and grant lifetime', async () => {
    const destination = randomUUID();
    await admin.query(
      `insert into public.accounts
      (id,workspace_id,name,type,currency,status,created_by)
      values ($1,$2,'MCP destination','checking','USD','active',$3)`,
      [destination, workspace, owner],
    );
    const restrictions = {
      toolAllowlist: ['create_transfer', 'contribute_to_fund'],
      schedule: fullWeek,
      scopes: ['transactions:write'],
      maxWriteAmount: { amountMinor: '9007199254740993', currency: 'USD' },
    };
    const granted = await created(
      body([workspace], {
        ...restrictions,
        accountIds: [account, destination],
      }),
    );
    const scoped = await created(
      body([workspace], { ...restrictions, accountIds: [account] }),
    );
    const expired = await created(
      body([workspace], {
        ...restrictions,
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    const call = transferCall(granted.id, [account, destination]);
    const client = await admin.connect();
    const evaluate = async (override: Partial<typeof call>, actor = owner) => {
      await beginActor(client, actor);
      try {
        return await authorize(client, { ...call, ...override });
      } finally {
        await client.query('rollback');
      }
    };
    try {
      expect(await evaluate({})).toBe(true);
      expect(await evaluate({}, other)).toBe(false);
      expect(await evaluate({ subject: other }, other)).toBe(false);
      expect(await evaluate({ grantId: randomUUID() })).toBe(false);
      expect(await evaluate({ grantId: scoped.id })).toBe(false);
      expect(await evaluate({ grantId: expired.id })).toBe(false);
      expect(await evaluate({ toolName: 'contribute_to_fund' })).toBe(false);
      await admin.query(
        `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'owner','active')`,
        [foreignWorkspace, owner],
      );
      expect(await evaluate({ workspaceId: foreignWorkspace })).toBe(false);
      expect(await evaluate({ accountIds: [account, outsideAccount] })).toBe(
        false,
      );
      expect(await evaluate({ accountIds: [account, randomUUID()] })).toBe(
        false,
      );
      await admin.query(
        `update public.workspace_memberships set role = 'viewer' where workspace_id = $1 and profile_id = $2`,
        [workspace, owner],
      );
      expect(await evaluate({})).toBe(false);
      await admin.query(
        `update public.workspace_memberships set status = 'suspended' where workspace_id = $1 and profile_id = $2`,
        [workspace, owner],
      );
      expect(await evaluate({})).toBe(false);
    } finally {
      client.release();
    }
  });

  it('uses the configured workspace timezone, denies invalid zones, and permits legacy read-only windows', async () => {
    const {
      rows: [zone],
    } = await admin.query<{ name: string; day: number }>(`
      select name, extract(isodow from timezone(name, now()))::integer as day
        from unnest(array['Pacific/Kiritimati', 'Pacific/Honolulu']) as zones(name)
       where extract(isodow from timezone(name, now())) <> extract(isodow from timezone('UTC', now()))
       limit 1`);
    expect(zone).toBeDefined();
    const legacyShape = await created(
      body([workspace], { schedule: fullWeek }),
    );
    const emptySchedule = await created();
    const scheduled = await created(
      body([workspace], {
        schedule: [
          { dayOfWeek: zone.day, startTime: '00:00', endTime: '24:00' },
        ],
      }),
    );
    const client = await admin.connect();
    const canRead = async (id: string) => {
      await beginActor(client);
      try {
        return await authorize(client, {
          ...transferCall(id, [account]),
          toolName: 'get_account_balance',
          amounts: [],
        });
      } finally {
        await client.query('rollback');
      }
    };
    try {
      expect(await canRead(legacyShape.id)).toBe(true);
      expect(await canRead(emptySchedule.id)).toBe(false);
      expect(await canRead(scheduled.id)).toBe(false);
      await admin.query(
        'update public.workspaces set timezone = $2 where id = $1',
        [workspace, zone.name],
      );
      expect(await canRead(scheduled.id)).toBe(true);
      await admin.query(
        'update public.workspaces set timezone = $2 where id = $1',
        [workspace, 'Not/A_Zone'],
      );
      expect(await canRead(legacyShape.id)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('serializes authorization with revocation and denies after revocation commits', async () => {
    const grant = await created(body([workspace], { schedule: fullWeek }));
    const client = await admin.connect();
    const revoker = await admin.connect();
    const call = {
      ...transferCall(grant.id, [account]),
      toolName: 'get_account_balance',
      amounts: [],
    };
    try {
      await beginActor(client);
      expect(await authorize(client, call)).toBe(true);
      await beginActor(revoker);
      await revoker.query("set local lock_timeout = '100ms'");
      await expect(
        adapter.revoke(
          revoker as unknown as TransactionClient,
          owner,
          grant.id,
          new Date(),
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await revoker.query('rollback');
      await client.query('commit');
      const revoked = await request('DELETE', `/v1/mcp/grants/${grant.id}`);
      expect(revoked.statusCode).toBe(204);
      await beginActor(client);
      expect(await authorize(client, call)).toBe(false);
    } finally {
      await revoker.query('rollback');
      await client.query('rollback');
      revoker.release();
      client.release();
    }
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
  it('refuses a viewer minting a data-write scope', async () => {
    await admin.query(
      `update public.workspace_memberships set role = 'viewer' where workspace_id = $1 and profile_id = $2`,
      [workspace, owner],
    );

    const response = await create(
      body([workspace], { scopes: ['accounts:write'] }),
    );

    expect(response.statusCode).toBe(403);
  });
  it('refuses an editor minting workspace administration', async () => {
    await admin.query(
      `update public.workspace_memberships set role = 'editor' where workspace_id = $1 and profile_id = $2`,
      [workspace, owner],
    );

    const response = await create(
      body([workspace], { scopes: ['workspace:admin'] }),
    );

    expect(response.statusCode).toBe(403);
  });
  it('judges a multi-workspace grant by the lower role', async () => {
    await admin.query(
      `insert into public.workspace_memberships (workspace_id,profile_id,role,status) values ($1,$2,'viewer','active')`,
      [foreignWorkspace, owner],
    );

    const response = await create(
      body([workspace, foreignWorkspace], { scopes: ['accounts:write'] }),
    );

    expect(response.statusCode).toBe(403);
  });
  it('rejects a direct RLS insert that bypasses the service check', async () => {
    await admin.query(
      `update public.workspace_memberships set role = 'viewer' where workspace_id = $1 and profile_id = $2`,
      [workspace, owner],
    );
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query('select set_config($1, $2, true)', [
        'app.subject_id',
        owner,
      ]);
      await expect(
        client.query(
          `insert into public.mcp_grants (subject_id,client_name,scopes,workspace_ids) values ($1,'direct',array['accounts:write'],array[$2::uuid])`,
          [owner, workspace],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
  it('hides a foreign account from a direct application predicate call', async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query('select set_config($1, $2, true)', [
        'app.subject_id',
        owner,
      ]);
      const result = await client.query<{ allowed: boolean }>(
        'select public.mcp_grant_accounts_within_workspaces($1::uuid[], $2::uuid[]) as allowed',
        [[outsideAccount], [foreignWorkspace]],
      );
      expect(result.rows[0]?.allowed).toBe(false);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
  it.each([
    ['an account from a workspace outside the grant', 'outside'],
    ['an account that does not exist', 'unknown'],
  ])('rejects a direct RLS insert naming %s', async (_description, kind) => {
    const accountId = kind === 'outside' ? outsideAccount : randomUUID();
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query('select set_config($1, $2, true)', [
        'app.subject_id',
        owner,
      ]);
      await expect(
        client.query(
          `insert into public.mcp_grants (subject_id,client_name,scopes,workspace_ids,account_ids) values ($1,'direct-account',array['accounts:read'],array[$2::uuid],array[$3::uuid])`,
          [owner, workspace, accountId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
  it('allows direct RLS inserts with null or empty account restrictions', async () => {
    const client = await admin.connect();
    try {
      for (const accountIds of ['null', 'array[]::uuid[]']) {
        await client.query('begin');
        await client.query('set local role savia_application');
        await client.query('select set_config($1, $2, true)', [
          'app.subject_id',
          owner,
        ]);
        await expect(
          client.query(
            `insert into public.mcp_grants (subject_id,client_name,scopes,workspace_ids,account_ids) values ($1,'direct-no-account',array['accounts:read'],array[$2::uuid],${accountIds})`,
            [owner, workspace],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
  });
  it('reproduces the migration dirty-data refusal when the harness cannot seed before migrations', async () => {
    await admin.query(
      `update public.workspace_memberships set role = 'viewer' where workspace_id = $1 and profile_id = $2`,
      [workspace, owner],
    );
    await admin.query(
      `insert into public.mcp_grants (subject_id,client_name,scopes,workspace_ids) values ($1,'dirty',array['accounts:write'],array[$2::uuid])`,
      [owner, workspace],
    );
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query('select set_config($1, $2, true)', [
        'app.subject_id',
        owner,
      ]);
      await expect(
        client.query(`
          do $$
          declare violating_count bigint;
          begin
            select count(*) into violating_count
              from public.mcp_grants grant_row
             where grant_row.subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
               and grant_row.status = 'active'
               and (grant_row.expires_at is null or grant_row.expires_at > now())
               and not public.mcp_grant_within_minter_role(grant_row.scopes, grant_row.workspace_ids);
            if violating_count > 0 then
              raise exception 'mcp grant minting policy refused to install: % active unexpired grant(s); revoke offending grants before retrying', violating_count;
            end if;
          end $$;
        `),
      ).rejects.toThrow(/refused to install: 1 active unexpired grant/);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
  it('counts an active grant with an outside account in the migration dirty-data refusal', async () => {
    await admin.query(
      `insert into public.mcp_grants (subject_id,client_name,scopes,workspace_ids,account_ids) values ($1,'dirty-account',array['accounts:read'],array[$2::uuid],array[$3::uuid])`,
      [owner, workspace, outsideAccount],
    );
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query('select set_config($1, $2, true)', [
        'app.subject_id',
        owner,
      ]);
      await expect(
        client.query(`
          do $$
          declare violating_count bigint;
          begin
            select count(*) into violating_count
              from public.mcp_grants grant_row
             where grant_row.status = 'active'
               and (grant_row.expires_at is null or grant_row.expires_at > now())
               and not public.mcp_grant_accounts_within_workspaces(grant_row.account_ids, grant_row.workspace_ids);
            if violating_count > 0 then
              raise exception 'mcp grant minting policy refused to install: % active unexpired grant(s); revoke offending grants before retrying', violating_count;
            end if;
          end $$;
        `),
      ).rejects.toThrow(/refused to install: 1 active unexpired grant/);
      await client.query('rollback');
    } finally {
      client.release();
    }
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
  it('round-trips a string amountMinor above JavaScript safe integer range', async () => {
    const amountMinor = '9007199254740993';
    const createdResponse = await create(
      body([workspace], { maxWriteAmount: { amountMinor, currency: 'USD' } }),
    );
    expect(createdResponse.statusCode).toBe(201);
    const grant = JSON.parse(createdResponse.payload) as {
      id: string;
      maxWriteAmount: { amountMinor: string; currency: string };
    };
    expect(grant.maxWriteAmount.amountMinor).toBe(amountMinor);
    const raw = await admin.query<{ maxWriteAmountMinor: unknown }>(
      'select max_write_amount_minor as "maxWriteAmountMinor" from public.mcp_grants where id = $1',
      [grant.id],
    );
    process.stderr.write(
      `PROBE postgres bigint typeof=${typeof raw.rows[0]?.maxWriteAmountMinor}`,
    );
    expect(typeof raw.rows[0]?.maxWriteAmountMinor).toBe('string');
    const listed = await request('GET', '/v1/mcp/grants');
    expect(listed.statusCode).toBe(200);
    const item = (
      JSON.parse(listed.payload) as { items: (typeof grant)[] }
    ).items.find((candidate) => candidate.id === grant.id);
    expect(item?.maxWriteAmount.amountMinor).toBe(amountMinor);
  });
  it('returns 409 when the same idempotency key changes only expiresAt', async () => {
    const key = randomUUID();
    expect(
      (
        await create(
          body([workspace], { expiresAt: '2026-01-01T00:00:00.000Z' }),
          key,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await create(
          body([workspace], { expiresAt: '2027-01-01T00:00:00.000Z' }),
          key,
        )
      ).statusCode,
    ).toBe(409);
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
