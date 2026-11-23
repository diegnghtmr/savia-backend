// Migrations under test: 202609170032_session_management.sql,
// 202609170033_dashboard_preferences.sql.
import { randomUUID } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { AuthConfig } from '../../src/platform/auth-config.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { PostgresSessionStore } from '../../src/platform/postgres-session.store.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresProfileAdapter } from '../../src/identity/postgres-profile.adapter.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

const auth = {
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
};

it('probes the local migration owner Auth session privileges without changing rows', async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(`
      select current_user as actor, pg_get_userbyid(c.relowner) as owner,
             has_schema_privilege(current_user, 'auth', 'USAGE') as schema_usage,
             has_schema_privilege(current_user, 'auth', 'USAGE WITH GRANT OPTION') as schema_grant,
             has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
             has_table_privilege(current_user, c.oid, 'SELECT WITH GRANT OPTION') as can_grant_select,
             has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
             has_table_privilege(current_user, c.oid, 'DELETE WITH GRANT OPTION') as can_grant_delete
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'auth' and c.relname = 'sessions'`);
    expect(rows).toEqual([
      {
        actor: 'postgres',
        owner: 'supabase_auth_admin',
        schema_usage: true,
        schema_grant: false,
        can_select: true,
        can_grant_select: true,
        can_delete: true,
        can_grant_delete: false,
      },
    ]);
    expect(
      (
        await pool.query(
          'select id, user_id, created_at, updated_at, refreshed_at, not_after, user_agent from auth.sessions limit 0',
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await pool.query('delete from auth.sessions where false')).rowCount,
    ).toBe(0);
    const privileges = await pool.query(`
      select role, p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
             p.proconfig as configuration, has_function_privilege(role, p.oid, 'EXECUTE') as allowed
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       cross join unnest(array['anon','authenticated','service_role','savia_worker','savia_elevated','savia_application']) as role
       where n.nspname = 'public' and p.proname in ('savia_session_is_active', 'savia_list_sessions', 'savia_revoke_other_sessions')
       order by role, p.proname`);
    expect(privileges.rows).toHaveLength(18);
    for (const row of privileges.rows) {
      expect(row).toMatchObject({
        owner: 'postgres',
        definer: true,
        configuration: ['search_path=""'],
        allowed: row.role === 'savia_application',
      });
    }
    expect(
      (
        await pool.query(`select
      has_any_column_privilege('savia_application', 'auth.sessions', 'SELECT') as can_select,
      has_table_privilege('savia_application', 'auth.sessions', 'DELETE') as can_delete`)
      ).rows,
    ).toEqual([{ can_select: false, can_delete: false }]);
  } finally {
    await pool.end();
  }
});

describe('session and dashboard HTTP database boundary', () => {
  const user = subject(610);
  const other = subject(612);
  const current = randomUUID();
  const secondSession = randomUUID();
  const foreignSession = randomUUID();
  const expired = randomUUID();
  const workspace = randomUUID();
  const otherWorkspace = randomUUID();
  let app: NestFastifyApplication;
  let admin: Pool;
  let sign: (
    subject: string,
    sessionId?: string,
    extra?: object,
  ) => Promise<string>;
  let headers: { authorization: string; 'x-workspace-id': string };

  beforeAll(async () => {
    // Independent fixtures; no test relies on another describe's setup.
    admin = new Pool({ connectionString: url });
    const ids = [user, other];
    for (const id of ids) {
      const email = `${id}@example.test`;
      await admin.query('insert into auth.users (id, email) values ($1, $2)', [
        id,
        email,
      ]);
      await admin.query(
        `insert into public.profiles (id,email,display_name,locale,country_code,timezone,date_format,week_starts_on,number_format,default_currency,privacy_mode_enabled)
        values ($1,$2,'L16 profile','en','US','UTC','YYYY-MM-DD',1,'1,234.56','USD',false)`,
        [id, email],
      );
    }
    await admin.query(
      `insert into public.workspaces(id,name,kind,base_currency) values ($1,'L16 shared','shared','USD'),($2,'L16 other','shared','EUR')`,
      [workspace, otherWorkspace],
    );
    await admin.query(
      `insert into public.workspace_memberships(workspace_id,profile_id,role,status)
      values ($1,$3,'owner','active'),($1,$4,'viewer','active'),($2,$3,'owner','active')`,
      [workspace, otherWorkspace, ...ids],
    );
    const now = new Date().toISOString();
    await admin.query(
      `insert into auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
      values ($1,$5,$7,$7,null,'test current'),($2,$5,$7,$7,null,null),($3,$6,$7,$7,null,null),($4,$5,$7,$7,'2000-01-01',null)`,
      [current, secondSession, foreignSession, expired, ...ids, now],
    );
    const pair = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'fixture' };
    sign = (id, sessionId, extra) =>
      new SignJWT({ session_id: sessionId, ...extra })
        .setSubject(id)
        .setIssuer(auth.JWT_ISSUER)
        .setAudience(auth.JWT_AUDIENCE)
        .setExpirationTime('10m')
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .sign(pair.privateKey);
    Object.assign(process.env, auth);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JoseJwtVerifier)
      .useFactory({
        inject: [PostgresSessionStore],
        factory: (sessions: PostgresSessionStore) =>
          new JoseJwtVerifier(AuthConfig.fromEnvironment(auth), sessions, {
            fetch: () => Promise.resolve(Response.json({ keys: [jwk] })),
          }),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    headers = {
      authorization: `Bearer ${await sign(user, current)}`,
      'x-workspace-id': workspace,
    };
  });

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('lists only owned active sessions, paginates, revokes the others and immediately rejects their JWTs', async () => {
    const list = async (query = '', requestHeaders = headers) =>
      app.inject({
        method: 'GET',
        url: `/v1/me/sessions${query}`,
        headers: requestHeaders,
      });
    const getProfile = async (token: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${token}` },
      });
    const otherToken = await sign(user, secondSession);
    expect((await getProfile(otherToken)).statusCode).toBe(200);
    const first = await list('?limit=1');
    expect(first.statusCode, first.payload).toBe(200);
    const { items, pageInfo } = first.json<{
      items: unknown[];
      pageInfo: { nextCursor: string; hasNextPage: boolean };
    }>();
    expect(pageInfo.hasNextPage).toBe(true);
    const second = await list(`?limit=1&cursor=${pageInfo.nextCursor}`);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    expect([...items, ...second.json<{ items: unknown[] }>().items]).toEqual(
      expect.arrayContaining([
        {
          id: current,
          createdAt: expect.any(String),
          lastActiveAt: expect.any(String),
          current: true,
          userAgent: 'test current',
        },
        {
          id: secondSession,
          createdAt: expect.any(String),
          lastActiveAt: expect.any(String),
          current: false,
        },
      ]),
    );
    expect((await list('?cursor=bad')).statusCode).toBe(400);
    for (const token of [
      await sign(user),
      await sign(user, expired),
      await sign(user, foreignSession),
      await sign(user, current, { client_id: 'oauth-client' }),
      await sign(user, current, { mcp_grant_id: randomUUID() }),
    ]) {
      expect((await getProfile(token)).statusCode).toBe(401);
    }
    const revoke = () =>
      app.inject({
        method: 'POST',
        url: '/v1/me/sessions/revoke-others',
        headers,
      });
    for (let n = 0; n < 2; n++) {
      const response = await revoke();
      expect(response.statusCode, response.payload).toBe(204);
      expect(response.payload).toBe('');
    }
    expect((await getProfile(otherToken)).statusCode).toBe(401);
    expect((await list()).json()).toMatchObject({
      items: [{ id: current, current: true }],
    });
    expect(
      (
        await list('', {
          ...headers,
          authorization: `Bearer ${await sign(other, foreignSession)}`,
        })
      ).json(),
    ).toMatchObject({ items: [{ id: foreignSession, current: true }] });
  });

  it('replaces per-workspace preferences with a version, replays exactly, and leaves other users and workspaces unchanged', async () => {
    const url = '/v1/me/dashboard-preferences';
    const get = (requestHeaders = headers) =>
      app.inject({ method: 'GET', url, headers: requestHeaders });
    const key = randomUUID();
    const preferences = {
      cards: [
        { id: 'net_worth', visible: false },
        { id: 'assets', visible: true },
      ],
      period: { preset: 'custom', from: '2026-01-01', to: '2026-03-31' },
      presentationCurrency: 'USD',
    };
    const put = (
      etag: string | undefined,
      payload: object = preferences,
      idempotencyKey = key,
    ) =>
      app.inject({
        method: 'PUT',
        url,
        headers: {
          ...headers,
          ...(etag === undefined ? {} : { 'if-match': etag }),
          'idempotency-key': idempotencyKey,
        },
        payload,
      });
    const initial = await get();
    expect(initial.statusCode, initial.payload).toBe(200);
    expect(initial.headers.etag).toBe('"1"');
    expect(initial.json()).toMatchObject({
      version: 1,
      presentationCurrency: 'USD',
    });
    for (const etag of [undefined, '*', 'W/"1"', '"1", "2"', '"2"']) {
      expect((await put(etag)).statusCode).toBe(412);
      expect((await get()).payload).toBe(initial.payload);
    }
    for (const payload of [
      { ...preferences, cards: [{ id: 'unknown', visible: false }] },
      { ...preferences, presentationCurrency: 'ZZZ' },
      {
        ...preferences,
        cards: [
          { id: 'assets', visible: false },
          { id: 'assets', visible: true },
        ],
      },
      {
        ...preferences,
        period: { preset: 'custom', from: '2026-02-30', to: '2026-03-01' },
      },
      {
        ...preferences,
        period: { preset: 'custom', from: '2026-03-31', to: '2026-03-01' },
      },
    ]) {
      expect((await put('"1"', payload)).statusCode).toBe(422);
      expect((await get()).payload).toBe(initial.payload);
    }
    const response = await put('"1"');
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json()).toEqual({ ...preferences, version: 2 });
    const replay = await put('"1"');
    expect(replay.statusCode).toBe(200);
    expect(replay.headers.etag).toBe('"2"');
    expect(replay.json()).toEqual(response.json());
    expect((await put('"1"', { ...preferences, cards: [] })).statusCode).toBe(
      409,
    );
    expect((await put('"1"', preferences, randomUUID())).statusCode).toBe(412);
    expect((await get()).json()).toEqual(response.json());
    const otherHeaders = {
      ...headers,
      authorization: `Bearer ${await sign(other, foreignSession)}`,
    };
    expect((await get(otherHeaders)).json()).toMatchObject({ version: 1 });
    expect(
      (await get({ ...headers, 'x-workspace-id': otherWorkspace })).json(),
    ).toMatchObject({ version: 1, presentationCurrency: 'EUR' });
    expect(
      (await get({ ...otherHeaders, 'x-workspace-id': otherWorkspace }))
        .statusCode,
    ).toBe(403);
  });
});

describe('PostgresProfileAdapter database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresProfileAdapter();

  const subjectA = subject(600);
  const subjectB = subject(601);
  const subjectC = subject(602);
  const subjectD = subject(603);
  const subjectE = subject(604);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
      [
        subjectA,
        'subject-a@example.test',
        subjectB,
        'subject-b@example.test',
        subjectC,
        'subject-c@example.test',
        subjectD,
        'subject-d@example.test',
        subjectE,
        'subject-e@example.test',
      ],
    );
    await admin.query(
      `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
       values ($1, 'subject-a@example.test', 'Subject A', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', true),
              ($2, 'subject-c@example.test', 'Subject C', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', true),
              ($3, 'subject-d@example.test', 'Subject D', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', true),
              ($4, 'subject-e@example.test', 'Subject E', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', true)`,
      [subjectA, subjectC, subjectD, subjectE],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('returns exactly the seven UserProfile keys and no extras under PgTransaction.runRead', async () => {
    const profile = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA),
    );
    expect(profile).toBeDefined();
    expect(Object.keys(profile!).sort()).toEqual(
      [
        'id',
        'email',
        'displayName',
        'locale',
        'timezone',
        'defaultCurrency',
        'privacyModeEnabled',
      ].sort(),
    );
  });

  it("subject B's runRead cannot see subject A's row (RLS proof)", async () => {
    const profile = await transaction.runRead(subjectB, (client) =>
      adapter.read(client, subjectA),
    );
    expect(profile).toBeUndefined();
  });

  it("subject A's own row is returned", async () => {
    const profile = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA),
    );
    expect(profile).toEqual({
      id: subjectA,
      email: 'subject-a@example.test',
      displayName: 'Subject A',
      locale: 'en',
      timezone: 'UTC',
      defaultCurrency: 'USD',
      privacyModeEnabled: true,
    });
  });

  it('a freshly inserted profile has version = 1 (202607150005_profile_version.sql)', async () => {
    const result = await admin.query<{ version: number }>(
      'select version from public.profiles where id = $1',
      [subjectA],
    );
    expect(result.rows[0]?.version).toBe(1);
  });

  it("savia_application inside PgTransaction.run for subject A can update A's own row and version becomes 2", async () => {
    const updateResult = await transaction.run(subjectA, (client) =>
      client.query(
        `update public.profiles set display_name = 'Subject A Updated', version = version + 1 where id = $1`,
        [subjectA],
      ),
    );
    expect(updateResult.rowCount).toBe(1);

    const result = await admin.query<{ version: number; display_name: string }>(
      'select version, display_name from public.profiles where id = $1',
      [subjectA],
    );
    expect(result.rows[0]?.version).toBe(2);
    expect(result.rows[0]?.display_name).toBe('Subject A Updated');
  });

  it("inside run for subject B, an update targeting A's row affects zero rows (RLS filters)", async () => {
    const before = await admin.query(
      'select * from public.profiles where id = $1',
      [subjectA],
    );
    const updateResult = await transaction.run(subjectB, (client) =>
      client.query(
        `update public.profiles set display_name = 'Subject A Hacked', version = version + 1 where id = $1`,
        [subjectA],
      ),
    );
    expect(updateResult.rowCount).toBe(0);

    const after = await admin.query(
      'select * from public.profiles where id = $1',
      [subjectA],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  // The cases above prove which ROW may be updated. This proves which COLUMNS
  // may be updated at all, which is a separate guarantee and the one that does
  // not depend on application code remembering the contract: the grant names
  // six columns, so email, id and created_at are unwritable by this role no
  // matter what a future controller asks for. Rejection is by privilege
  // (SQLSTATE 42501), before any policy is consulted.
  //
  // Because id is among the ungranted columns, a row also cannot be moved out
  // of the caller's scope -- so the policy's `with check` is belt-and-braces
  // here. Worth stating plainly, since it is tempting to read that clause as
  // the thing doing the work: PostgreSQL applies the `using` expression as the
  // check expression when a policy declares none, and the two are identical
  // here, so the explicit clause documents intent rather than adding
  // enforcement. Measured, not assumed -- removing it changed no result.
  it('cannot update a column outside the update grant', async () => {
    for (const statement of [
      'update public.profiles set email = $2 where id = $1',
      'update public.profiles set id = $2 where id = $1',
    ]) {
      await expect(
        transaction.run(subjectA, (client) =>
          client.query(statement, [subjectA, subjectB]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const row = await admin.query(
      'select id, email from public.profiles where id = $1',
      [subjectA],
    );
    expect(row.rows[0]).toEqual({
      id: subjectA,
      email: 'subject-a@example.test',
    });
  });

  it('adapter.update with matching version writes exactly once and version becomes 2', async () => {
    const updateResult = await transaction.run(subjectC, (client) =>
      adapter.update(
        client,
        subjectC,
        { displayName: 'Subject C Updated', locale: 'es' },
        1,
      ),
    );
    expect(updateResult).toBeDefined();
    expect(updateResult?.version).toBe(2);
    expect(updateResult?.displayName).toBe('Subject C Updated');
    expect(updateResult?.locale).toBe('es');

    const adminCheck = await admin.query<{
      version: number;
      display_name: string;
      locale: string;
    }>(
      'select version, display_name, locale from public.profiles where id = $1',
      [subjectC],
    );
    expect(adminCheck.rows[0]?.version).toBe(2);
    expect(adminCheck.rows[0]?.display_name).toBe('Subject C Updated');
    expect(adminCheck.rows[0]?.locale).toBe('es');
  });

  it('adapter.update with stale version writes nothing: row is byte-for-byte unchanged AND version is unchanged', async () => {
    const before = await admin.query(
      'select * from public.profiles where id = $1',
      [subjectD],
    );
    expect(before.rows[0]?.version).toBe(1);

    const updateResult = await transaction.run(subjectD, (client) =>
      adapter.update(
        client,
        subjectD,
        { displayName: 'Subject D Stale Update' },
        99,
      ),
    );
    expect(updateResult).toBeUndefined();

    const after = await admin.query(
      'select * from public.profiles where id = $1',
      [subjectD],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]?.version).toBe(1);

    const versionCheck = await transaction.runRead(subjectD, (client) =>
      adapter.readVersion(client, subjectD),
    );
    expect(versionCheck).toBe(1);
  });

  // `false` is falsy, so an adapter that folded absent-and-false together with
  // `||` instead of `??` would turn "set privacy mode off" into "leave it as it
  // was" -- and every other update test would still pass, because they all set
  // truthy values. The fixture row starts at true precisely so this one can only
  // pass by actually writing false.
  it('writes privacyModeEnabled false rather than treating it as absent', async () => {
    const updated = await transaction.run(subjectE, (client) =>
      adapter.update(client, subjectE, { privacyModeEnabled: false }, 1),
    );
    expect(updated?.privacyModeEnabled).toBe(false);
    const stored = await admin.query<{ privacy_mode_enabled: boolean }>(
      'select privacy_mode_enabled from public.profiles where id = $1',
      [subjectE],
    );
    expect(stored.rows[0]?.privacy_mode_enabled).toBe(false);
  });
});
