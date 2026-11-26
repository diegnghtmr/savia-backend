// Migrations under test: 202609060003_notifications.sql, 202609170006_notification_production.sql,
// 202609170016_notification_settings.sql, 202609170020_notification_mute_at_creation.sql,
// 202609170038_notification_delivery_timezone_lookup.sql
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { CliTokenVerifier } from '../../src/platform/cli-token-verifier.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { SAVIA_SCOPES } from '../../src/platform/savia-scopes.js';
import {
  PgTransaction,
  type TransactionClient,
} from '../../src/platform/pg-transaction.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PostgresNotificationAdapter } from '../../src/notifications/postgres-notification.adapter.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('Notifications integration contract and endpoint suite', () => {
  let admin: Pool;
  let application: NestFastifyApplication;

  const user1Id = '11111111-0000-4000-8000-000000000001';
  const user2Id = '22222222-0000-4000-8000-000000000002';
  const user1Token = 'user1-token';
  const user2Token = 'user2-token';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    // Seed auth.users
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'user1@example.test'),
        ($2, 'user2@example.test')
       on conflict (id) do nothing`,
      [user1Id, user2Id],
    );

    // Seed public.profiles
    for (const [userId, email, name] of [
      [user1Id, 'user1@example.test', 'User One'],
      [user2Id, 'user2@example.test', 'User Two'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (
          id, email, display_name, locale, country_code, timezone,
          date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled
        ) values (
          $1, $2, $3, 'en', 'US', 'UTC',
          'YYYY-MM-DD', 1, '1,234.56', 'USD', false
        ) on conflict (id) do nothing`,
        [userId, email, name],
      );
    }

    // Bootstrap Nest application with Fastify adapter
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === user1Token) return { subject: user1Id };
          if (token === user2Token) return { subject: user2Id };
          throw new Error('token rejected');
        },
      })
      .overrideProvider(CliTokenVerifier)
      .useValue({
        verify: async () => ({
          subject: user1Id,
          authMethod: 'cli_token',
          scopes: Object.values(SAVIA_SCOPES),
        }),
      })
      .compile();

    application = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(application);
    await application.init();
    await application.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (application) {
      await application.close();
    }
    if (admin) {
      await admin.end();
    }
  });

  describe('notification delivery timezone lookup', () => {
    it('keeps exact catalog names and falls back to UTC for nonmembers', async () => {
      // EST5EDT is accepted only if this Postgres installation lists it as a
      // name. Accepting a value in AT TIME ZONE (e.g. PST or UTC+5) is not enough.
      const zones = [
        'America/Bogota',
        'america/bogota',
        'EST5EDT',
        'UTC+5',
        'PST',
        'Mars/Olympus',
        null,
        '',
      ];
      const { rows } = await admin.query<{
        zone: string | null;
        actual: string;
        expected: string;
      }>(
        `with zone_names as materialized (select name from pg_catalog.pg_timezone_names)
         select input.zone, public.notification_delivery_timezone(input.zone) as actual,
                coalesce(zone_names.name, 'UTC') as expected
           from unnest($1::text[]) with ordinality as input(zone, position)
           left join zone_names on zone_names.name = input.zone
          order by input.position`,
        [zones],
      );
      expect(rows.map(({ zone }) => zone)).toEqual(zones);
      expect(rows.map(({ actual }) => actual)).toEqual(
        rows.map(({ expected }) => expected),
      );
    });

    it('does not enumerate pg_timezone_names per lookup', async () => {
      const { rows } = await admin.query<{ definition: string }>(
        `select pg_get_functiondef('public.notification_delivery_timezone(text)'::regprocedure)
                as definition`,
      );
      expect(rows[0].definition).not.toMatch(/\bpg_timezone_names\b/i);
    });

    it('keeps the stable invoker function restricted to the delivery role', async () => {
      const { rows } = await admin.query(`
        select pg_get_userbyid(p.proowner) as owner, p.provolatile::text as volatility,
               p.prosecdef as security_definer, p.proconfig as config,
               array(
                 select coalesce(r.rolname::text, 'PUBLIC')
                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   left join pg_roles r on r.oid = a.grantee
                  where a.privilege_type = 'EXECUTE'
                  order by 1
               ) as executors
          from pg_proc p where p.oid = 'public.notification_delivery_timezone(text)'::regprocedure`);
      expect(rows).toEqual([
        {
          owner: 'savia_notification_delivery',
          volatility: 's',
          security_definer: false,
          config: ['search_path=pg_catalog'],
          executors: ['savia_notification_delivery'],
        },
      ]);
    });

    it('grants only read access on the lookup table to the delivery role', async () => {
      const { rows } = await admin.query(`
        select coalesce(r.rolname::text, 'PUBLIC') as grantee, a.privilege_type
          from pg_class c cross join lateral aclexplode(c.relacl) a
          left join pg_roles r on r.oid = a.grantee
         where c.oid = to_regclass('public.notification_delivery_timezone_names')
           and a.grantee <> c.relowner
         order by 1, 2`);
      expect(rows).toEqual([
        { grantee: 'savia_notification_delivery', privilege_type: 'SELECT' },
      ]);
    });
  });

  describe('notification preferences', () => {
    const url = '/v1/me/notification-preferences';
    const defaults = {
      channels: { in_app: true, push: true, email: true },
      quietHours: null,
      digestEnabled: true,
    };
    const get = (token = user1Token) =>
      application.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
    const put = (payload: object, key?: string, tag?: string) =>
      application.inject({
        method: 'PUT',
        url,
        headers: {
          authorization: `Bearer ${user1Token}`,
          ...(key === undefined ? {} : { 'idempotency-key': key }),
          ...(tag === undefined ? {} : { 'if-match': tag }),
        },
        payload,
      });

    it('uses subject-scoped defaults, conditionally replaces them and replays the original representation', async () => {
      const initial = await get();
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual(defaults);
      const tag = initial.headers.etag as string;
      expect(tag).toMatch(/^"\d+"$/);
      const input = {
        ...defaults,
        channels: { in_app: false, push: true, email: false },
        quietHours: {
          start: '22:00',
          end: '07:30',
          timezone: 'America/Bogota',
        },
      };
      const key = randomUUID();
      const saved = await put(input, key, tag);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual(input);
      expect(saved.headers.etag).not.toBe(tag);
      expect((await put(defaults, key, tag)).statusCode).toBe(409);
      const next = await put(
        defaults,
        randomUUID(),
        saved.headers.etag as string,
      );
      expect(next.statusCode).toBe(200);
      const replay = await put(input, key, tag);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers.etag).toBe(saved.headers.etag);
      expect(replay.json()).toEqual(input);
      expect((await put(input, randomUUID(), tag)).statusCode).toBe(412);
      const current = await get();
      expect(current.json()).toEqual(defaults);
      expect(current.headers.etag).toBe(next.headers.etag);
      const peer = await get(user2Token);
      expect(peer.json()).toEqual(defaults);
      expect(peer.headers.etag).toBe(tag);
    });

    it('rejects malformed input and invalid quiet hours without changing settings or consuming the key', async () => {
      const before = await get();
      const tag = before.headers.etag as string;
      const key = randomUUID();
      const quiet = { start: '22:00', end: '07:30', timezone: 'UTC' };
      expect((await put(defaults)).statusCode).toBe(400);
      expect((await put(defaults, key, 'W/"0"')).statusCode).toBe(412);
      for (const [patch, status] of [
        [{ start: '24:00' }, 400],
        [{ end: '7:30' }, 400],
        [{ end: '07:30\n' }, 400],
        [{ timezone: '+01:00' }, 422],
        [{ timezone: 'Mars/Olympus' }, 422],
        [{ end: '22:00' }, 422],
      ] as const) {
        const response = await put(
          { ...defaults, quietHours: { ...quiet, ...patch } },
          key,
          tag,
        );
        expect(response.statusCode).toBe(status);
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(response.json()).toMatchObject({ status });
        const unchanged = await get();
        expect(unchanged.headers.etag).toBe(tag);
        expect(unchanged.json()).toEqual(before.json());
      }
      const valid = await put({ ...defaults, quietHours: quiet }, key, '*');
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ ...defaults, quietHours: quiet });
      expect((await put(defaults, randomUUID())).statusCode).toBe(200);
    });

    it('prevents a second conditional update against the same version', async () => {
      const initial = await get();
      const tag = initial.headers.etag as string;
      const results = await Promise.all([
        put(defaults, randomUUID(), tag),
        put({ ...defaults, digestEnabled: false }, randomUUID(), tag),
      ]);
      expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([
        200, 412,
      ]);
      const winner = results.find(({ statusCode }) => statusCode === 200)!;
      const current = await get();
      expect(current.json()).toEqual(winner.json());
      expect(current.headers.etag).toBe(winner.headers.etag);
      expect((await put(defaults, randomUUID())).statusCode).toBe(200);
    });

    it('keeps existing inbox entries and suppresses new in-app delivery while disabled', async () => {
      const publish = async (title: string) => {
        await admin.query(
          `insert into public.notifications (subject_id, type, title) values ($1, 'system', $2)`,
          [user1Id, title],
        );
      };
      try {
        await publish('Before disable');
        const noInbox = {
          ...defaults,
          channels: { ...defaults.channels, in_app: false },
        };
        expect((await put(noInbox, randomUUID())).statusCode).toBe(200);
        await publish('While disabled');
        expect((await put(defaults, randomUUID())).statusCode).toBe(200);
        await publish('After enabling');
        const inbox = await application.inject({
          method: 'GET',
          url: '/v1/notifications',
          headers: { authorization: `Bearer ${user1Token}` },
        });
        expect(inbox.statusCode).toBe(200);
        const titles = inbox
          .json<{ items: { title: string }[] }>()
          .items.map(({ title }) => title);
        expect(titles.sort()).toEqual(['After enabling', 'Before disable']);
      } finally {
        await admin.query(
          'delete from public.notifications where subject_id = $1',
          [user1Id],
        );
      }
    });
  });

  it.each([
    ['GET', '/v1/me/notification-preferences'],
    ['PUT', '/v1/me/notification-preferences'],
    ['POST', '/v1/me/push-devices'],
    ['DELETE', `/v1/me/push-devices/${randomUUID()}`],
  ] as const)('%s %s requires a session JWT', async (method, url) => {
    const anonymous = await application.inject({ method, url });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'unauthorized' });
    const cli = await application.inject({
      method,
      url,
      headers: { authorization: 'Bearer svt_test' },
    });
    expect(cli.statusCode).toBe(401);
    expect(cli.headers['content-type']).toContain('application/problem+json');
    expect(cli.json()).toMatchObject({
      type: 'https://savia.app/problems/unauthorized',
      code: 'unauthorized',
      title: 'Authentication is required',
      status: 401,
    });
  });

  it('keeps CLI denial on the existing approval detail route at 403', async () => {
    const url = `/v1/approvals/${randomUUID()}`;
    const denied = await application.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer svt_test' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(denied.json()).toMatchObject({
      type: 'https://savia.app/problems/forbidden',
      code: 'forbidden',
      title: 'Forbidden',
      status: 403,
      instance: url,
    });
  });

  describe('push devices', () => {
    const url = '/v1/me/push-devices';
    const post = (payload: object, token = user1Token) =>
      application.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    const remove = (id: string, token = user1Token) =>
      application.inject({
        method: 'DELETE',
        url: `${url}/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });

    it('deduplicates concurrent registration, never echoes the token and allows only the owner to remove it', async () => {
      const expoPushToken = `ExponentPushToken[${randomUUID()}]`;
      const body = { expoPushToken, platform: 'ios', appVersion: '1.0.0' };
      const responses = await Promise.all([post(body), post(body)]);
      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([
        200, 201,
      ]);
      const { deviceId } = responses[0].json<{ deviceId: string }>();
      expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
      for (const response of responses)
        expect(response.json()).toEqual({ deviceId });
      const update = await post({
        ...body,
        platform: 'android',
        appVersion: '2.0.0',
      });
      expect(update.statusCode).toBe(200);
      expect(update.json()).toEqual({ deviceId });
      const conflict = await post(body, user2Token);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: 'conflict' });
      expect(conflict.body).not.toContain(expoPushToken);
      expect(conflict.body).not.toContain(deviceId);
      expect((await remove(deviceId, user2Token)).statusCode).toBe(404);
      expect((await post(body)).json()).toEqual({ deviceId });
      const removed = await remove(deviceId);
      expect(removed.statusCode).toBe(204);
      expect(removed.body).toBe('');
      expect((await remove(deviceId)).statusCode).toBe(404);
      const transferred = await post(body, user2Token);
      expect(transferred.statusCode).toBe(201);
      expect(transferred.json().deviceId).not.toBe(deviceId);
      expect(
        (await remove(transferred.json().deviceId, user2Token)).statusCode,
      ).toBe(204);
    });

    it('rejects malformed registrations without reserving their token', async () => {
      const expoPushToken = `ExpoPushToken[${randomUUID()}]`;
      const body = { expoPushToken, platform: 'android', appVersion: '1.0.0' };
      for (const patch of [
        { expoPushToken: 'native-token' },
        { expoPushToken: `${expoPushToken}\n` },
        { expoPushToken: `ExpoPushToken[${'x'.repeat(241)}]` },
        { platform: 'web' },
        { appVersion: '' },
        { appVersion: 'x'.repeat(65) },
        { other: true },
      ]) {
        const rejected = await post({ ...body, ...patch });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({ code: 'bad-request' });
        expect(rejected.body).not.toContain(expoPushToken);
      }
      expect((await remove('invalid-id')).statusCode).toBe(400);
      const created = await post(body);
      expect(created.statusCode).toBe(201);
      expect((await remove(created.json().deviceId)).statusCode).toBe(204);
    });
  });

  it('reports an unavailable database without exposing its failure details', async () => {
    const connect = vi.spyOn(application.get(PostgresPool), 'connect');
    connect.mockRejectedValueOnce(
      Object.assign(new Error('Connection details must stay private'), {
        code: 'ECONNREFUSED',
      }),
    );
    try {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/me/notification-preferences',
        headers: { authorization: `Bearer ${user1Token}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
      expect(response.json()).toMatchObject({
        status: 503,
        code: 'dependency-unavailable',
        title: 'Notification settings unavailable',
      });
      expect(response.body).not.toContain('Connection details');
    } finally {
      connect.mockRestore();
    }
  });

  // Reviewer regressions (verify mwr36929).
  it('mutes only notifications produced while the push and email channels are off', async () => {
    const authorization = `Bearer ${user1Token}`;
    const preferences = '/v1/me/notification-preferences';
    const expoPushToken = `ExpoPushToken[${randomUUID()}]`;
    const put = (on: boolean) =>
      application.inject({
        method: 'PUT',
        url: preferences,
        headers: { authorization, 'idempotency-key': randomUUID() },
        payload: {
          channels: { in_app: true, push: on, email: on },
          quietHours: null,
          digestEnabled: false,
        },
      });
    const notify = (title: string) =>
      admin.query(
        `insert into public.notifications (subject_id, type, title)
         values ($1, 'system', $2)`,
        [user1Id, title],
      );
    const claims = async () => {
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        const {
          rows: [claim],
        } = await admin.query(
          'select * from public.claim_notification_delivery(true)',
        );
        if (!claim) break;
        seen.push(`${claim.channel}:${claim.title}`);
        await admin.query(
          'select public.finish_notification_delivery($1, $2, $3, $4)',
          [claim.delivery_id, claim.lease_id, 'accepted', 5],
        );
      }
      return seen.sort();
    };
    const device = await application.inject({
      method: 'POST',
      url: '/v1/me/push-devices',
      headers: { authorization },
      payload: { expoPushToken, platform: 'ios', appVersion: '1' },
    });
    expect(device.statusCode).toBe(201);
    try {
      await admin.query(
        'update auth.users set email_confirmed_at = now() where id = $1',
        [user1Id],
      );
      expect((await put(true)).statusCode).toBe(200);
      await notify('Reviewer before mute');
      expect((await put(false)).statusCode).toBe(200);
      const whileMuted = await claims();
      await notify('Reviewer during mute');
      expect((await put(true)).statusCode).toBe(200);
      await notify('Reviewer after mute');
      expect({ whileMuted, afterUnmute: await claims() }).toEqual({
        whileMuted: ['email:Reviewer before mute', 'push:Reviewer before mute'],
        afterUnmute: ['email:Reviewer after mute', 'push:Reviewer after mute'],
      });
    } finally {
      await admin.query(
        'delete from public.notifications where subject_id = $1',
        [user1Id],
      );
      await admin.query(
        'update auth.users set email_confirmed_at = null where id = $1',
        [user1Id],
      );
      await application.inject({
        method: 'DELETE',
        url: `/v1/me/push-devices/${device.json().deviceId}`,
        headers: { authorization },
      });
      await put(true);
    }
  });

  it("never lets the peer query another subject's push token under application RLS", async () => {
    const expoPushToken = `ExpoPushToken[${randomUUID()}]`;
    const authorization = `Bearer ${user1Token}`;
    const url = '/v1/me/push-devices';
    const added = await application.inject({
      method: 'POST',
      url,
      headers: { authorization },
      payload: { expoPushToken, platform: 'android', appVersion: '1' },
    });
    expect(added.statusCode).toBe(201);
    const { deviceId } = added.json();
    const tx = new PgTransaction(application.get(PostgresPool));
    const read = (subject: string) =>
      tx.runRead(subject, (client) =>
        client.query(
          'select expo_token from public.push_devices where id = $1',
          [deviceId],
        ),
      );
    try {
      expect((await read(user1Id)).rows).toEqual([
        { expo_token: expoPushToken },
      ]);
      expect((await read(user2Id)).rows).toEqual([]);
    } finally {
      await application.inject({
        method: 'DELETE',
        url: `${url}/${deviceId}`,
        headers: { authorization },
      });
    }
  });

  it('deduplicates produced events and hides them after workspace access is lost', async () => {
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency) values
       ($1, 'Notifications A', 'shared', 'USD'), ($2, 'Notifications B', 'shared', 'USD')`,
      [workspaceId, otherWorkspaceId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
       ($1, $3, 'editor', 'active'), ($1, $4, 'owner', 'active'), ($2, $3, 'owner', 'active')`,
      [workspaceId, otherWorkspaceId, user1Id, user2Id],
    );
    const tx = new PgTransaction(application.get(PostgresPool), {
      callbackTimeoutMs: 3_000,
      statementTimeoutMs: 850,
      lockTimeoutMs: 650,
    });
    const readLimits = async (client: TransactionClient) => {
      const result =
        await client.query(`select current_setting('statement_timeout') as statement,
                                                current_setting('lock_timeout') as lock`);
      return result.rows[0];
    };
    const limits = { statement: '850ms', lock: '650ms' };
    const writer = application.get(PostgresNotificationAdapter);
    const event = {
      workspaceId,
      recipientId: user1Id,
      resourceId: randomUUID(),
      type: 'report_completed',
      title: 'Report available',
    };
    const list = async (token: string) => {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{
        items: { id: string; title: string; read: boolean }[];
      }>().items;
    };
    const markRead = (id: string) =>
      application.inject({
        method: 'POST',
        url: `/v1/notifications/${id}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': randomUUID(),
        },
      });

    await tx.run(user1Id, async (client) => {
      expect(await readLimits(client)).toEqual(limits);
      await writer.publish(client, { ...event, title: '' }); // Constraint failure must not abort this transaction.
      expect(await readLimits(client)).toEqual(limits);
      await writer.publish(client, {
        ...event,
        recipientId: user2Id,
        title: 'Forged recipient',
      });
      await writer.publish(client, event);
      expect(await readLimits(client)).toEqual(limits);
      await writer.publish(client, {
        ...event,
        workspaceId: otherWorkspaceId,
        title: 'Other workspace',
      });
      await writer.publish(client, {
        ...event,
        type: 'import_completed',
        title: 'Other event',
      });
      await writer.publish(client, {
        ...event,
        resourceId: randomUUID(),
        title: 'Other resource',
      });
    });
    const items = await list(user1Token);
    expect(items.map(({ title }) => title).sort()).toEqual([
      'Other event',
      'Other resource',
      'Other workspace',
      'Report available',
    ]);
    expect(await list(user2Token)).toEqual([]);
    const report = items.find(({ title }) => title === event.title)!;
    expect(report.read).toBe(false);
    const marked = await markRead(report.id);
    expect(marked.statusCode).toBe(204);
    expect(marked.body).toBe('');

    await tx.run(user1Id, (client) =>
      writer.publish(client, { ...event, title: 'Duplicate' }),
    );
    await tx.run(user2Id, (client) =>
      writer.publish(client, { ...event, recipientId: user2Id }),
    );
    expect(await list(user1Token)).toEqual(
      items.map((item) =>
        item.id === report.id ? { ...item, read: true } : item,
      ),
    );
    expect(await list(user2Token)).toEqual([
      expect.objectContaining({ title: event.title, read: false }),
    ]);

    await admin.query(
      'delete from public.workspace_memberships where workspace_id = $1 and profile_id = $2',
      [workspaceId, user1Id],
    );
    await tx.run(user1Id, (client) =>
      writer.publish(client, { ...event, resourceId: randomUUID() }),
    );
    expect((await list(user1Token)).map(({ title }) => title)).toEqual([
      'Other workspace',
    ]);
    const hidden = await markRead(report.id);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ title: 'Notification not found' });
    const count = await admin.query(
      'select count(*)::int as count from public.notifications where subject_id = $1',
      [user1Id],
    );
    expect(count.rows[0].count).toBe(4);
  });

  describe('Database schema, RLS, and constraints', () => {
    it('has named constraints installed on public.notifications', async () => {
      const result = await admin.query<{ constraintName: string }>(
        `select con.conname as "constraintName"
           from pg_class c join pg_constraint con on con.conrelid = c.oid
          where c.relname = 'notifications'
          order by con.conname`,
      );
      const names = result.rows.map((r) => r.constraintName);
      expect(names).toContain('notifications_type_check');
      expect(names).toContain('notifications_title_length_check');
      expect(names).toContain('notifications_read_state_check');
    });

    it('has RLS enabled and forced on public.notifications', async () => {
      const result = await admin.query<{
        rowsecurity: boolean;
        forcerowsecurity: boolean;
      }>(
        `select relrowsecurity as "rowsecurity",
                relforcerowsecurity as "forcerowsecurity"
           from pg_class
          where relname = 'notifications'`,
      );
      expect(result.rows[0].rowsecurity).toBe(true);
      expect(result.rows[0].forcerowsecurity).toBe(true);
    });

    it('has column-scoped grants on public.notifications for savia_application', async () => {
      // Check table level privileges: SELECT is granted, INSERT and DELETE are NOT granted
      const tablePrivileges = await admin.query<{ privilege_type: string }>(
        `select privilege_type
           from information_schema.table_privileges
          where table_name = 'notifications'
            and grantee = 'savia_application'`,
      );
      const privs = tablePrivileges.rows.map((r) => r.privilege_type);
      expect(privs).toContain('SELECT');
      expect(privs).not.toContain('INSERT');
      expect(privs).not.toContain('DELETE');

      // Check column level privileges: UPDATE on read and read_at ONLY
      const colPrivileges = await admin.query<{
        column_name: string;
        privilege_type: string;
      }>(
        `select column_name, privilege_type
           from information_schema.column_privileges
          where table_name = 'notifications'
            and grantee = 'savia_application'`,
      );
      const updateCols = colPrivileges.rows
        .filter((r) => r.privilege_type === 'UPDATE')
        .map((r) => r.column_name)
        .sort();
      expect(updateCols).toEqual(['read', 'read_at']);
    });

    it('enforces notifications_type_check format constraint', async () => {
      // Rejects uppercase characters
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, 'UPPERCASE_TYPE', 'Test Title')`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_type_check/);

      // Rejects leading digit
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, '1_leading_digit', 'Test Title')`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_type_check/);

      // Rejects empty string
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, '', 'Test Title')`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_type_check/);

      // Rejects exceeding bounded length (64 chars)
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, $2, 'Test Title')`,
          [user1Id, 'a'.repeat(65)],
        ),
      ).rejects.toThrow(/notifications_type_check/);

      // Accepts a well-formed open event type not in the old speculative enumeration
      const customType = 'workspace_billing_threshold_reached';
      const insertResult = await admin.query<{ id: string }>(
        `insert into public.notifications (subject_id, type, title)
         values ($1, $2, 'Well-formed Custom Type')
         returning id`,
        [user1Id, customType],
      );
      expect(insertResult.rows[0].id).toBeDefined();
    });

    it('enforces notifications_title_length_check constraint', async () => {
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, 'system', '')`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_title_length_check/);

      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, 'system', $2)`,
          [user1Id, 'x'.repeat(256)],
        ),
      ).rejects.toThrow(/notifications_title_length_check/);
    });

    it('enforces notifications_read_state_check constraint', async () => {
      // read = true but read_at is null
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title, read, read_at)
           values ($1, 'system', 'Title', true, null)`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_read_state_check/);

      // read = false but read_at is not null
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title, read, read_at)
           values ($1, 'system', 'Title', false, now())`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_read_state_check/);
    });
  });

  describe('Endpoints: authentication, authorization and subject scoping', () => {
    it('returns 401 on GET /v1/notifications without token', async () => {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/notifications',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 on POST /v1/notifications/:id/read without token', async () => {
      const response = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${randomUUID()}/read`,
        headers: {
          'idempotency-key': randomUUID(),
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns an empty page for a subject with no notifications', async () => {
      // Clean notifications for user2
      await admin.query(
        'delete from public.notifications where subject_id = $1',
        [user2Id],
      );

      const response = await application.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: `Bearer ${user2Token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toEqual([]);
      expect(body.pageInfo).toEqual({
        hasNextPage: false,
        nextCursor: null,
      });
    });

    it('keeps another subject notifications completely invisible in the list', async () => {
      await admin.query(
        'delete from public.notifications where subject_id in ($1, $2)',
        [user1Id, user2Id],
      );

      // Seed a notification for user2
      const notifUser2 = randomUUID();
      await admin.query(
        `insert into public.notifications (id, subject_id, type, title)
         values ($1, $2, 'approval_requested', 'Private user2 notification')`,
        [notifUser2, user2Id],
      );

      // User1 lists notifications
      const response = await application.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.items).toEqual([]);
    });

    it('returns 404 when attempting to mark read a notification belonging to another subject', async () => {
      // Seed a notification for user2
      const notifUser2 = randomUUID();
      await admin.query(
        `insert into public.notifications (id, subject_id, type, title)
         values ($1, $2, 'system', 'Another subject notification')`,
        [notifUser2, user2Id],
      );

      // User1 attempts to mark user2 notification as read
      const response = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifUser2}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': randomUUID(),
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload);
      expect(body.title).toBe('Notification not found');
    });

    it('returns 404 when notification does not exist', async () => {
      const response = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${randomUUID()}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': randomUUID(),
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Cursor pagination with total ordering and unreadOnly composition', () => {
    it('pages through shuffled mixed read/unread fixtures with unreadOnly=true asserting every unread row appears exactly once', async () => {
      await admin.query(
        'delete from public.notifications where subject_id = $1',
        [user1Id],
      );

      // Seed 6 fixtures with distinct timestamps and IDs, inserted in SHUFFLED order
      // 3 unread, 3 read
      const fixtures = [
        {
          id: '10000000-0000-4000-8000-000000000001',
          ts: '2026-09-07 10:01:00+00',
          read: false,
          title: 'Unread 1',
        },
        {
          id: '20000000-0000-4000-8000-000000000002',
          ts: '2026-09-07 10:02:00+00',
          read: true,
          title: 'Read 1',
        },
        {
          id: '30000000-0000-4000-8000-000000000003',
          ts: '2026-09-07 10:03:00+00',
          read: false,
          title: 'Unread 2',
        },
        {
          id: '40000000-0000-4000-8000-000000000004',
          ts: '2026-09-07 10:04:00+00',
          read: true,
          title: 'Read 2',
        },
        {
          id: '50000000-0000-4000-8000-000000000005',
          ts: '2026-09-07 10:05:00+00',
          read: false,
          title: 'Unread 3',
        },
        {
          id: '60000000-0000-4000-8000-000000000006',
          ts: '2026-09-07 10:06:00+00',
          read: true,
          title: 'Read 3',
        },
      ];

      // Shuffle insertion order intentionally
      const shuffled = [
        fixtures[3],
        fixtures[0],
        fixtures[5],
        fixtures[1],
        fixtures[4],
        fixtures[2],
      ];
      for (const f of shuffled) {
        await admin.query(
          `insert into public.notifications (id, subject_id, type, title, read, read_at, created_at)
           values ($1, $2, 'system', $3, $4, case when $4 then now() else null end, $5::timestamptz)`,
          [f.id, user1Id, f.title, f.read, f.ts],
        );
      }

      // Page with limit=2 and unreadOnly=true
      const collectedUnreadIds: string[] = [];
      let cursor: string | null = null;
      let pageCount = 0;

      while (true) {
        pageCount++;
        const url = cursor
          ? `/v1/notifications?limit=2&unreadOnly=true&cursor=${encodeURIComponent(cursor)}`
          : '/v1/notifications?limit=2&unreadOnly=true';

        const res = await application.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${user1Token}` },
        });

        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.payload);
        for (const item of data.items) {
          expect(item.read).toBe(false);
          collectedUnreadIds.push(item.id);
        }

        if (!data.pageInfo.hasNextPage) {
          expect(data.pageInfo.nextCursor).toBeNull();
          break;
        }
        expect(data.pageInfo.nextCursor).not.toBeNull();
        cursor = data.pageInfo.nextCursor;
      }

      // 3 unread items across pages of limit=2 requires exactly 2 pages
      expect(pageCount).toBe(2);
      expect(collectedUnreadIds).toEqual([
        fixtures[0].id,
        fixtures[2].id,
        fixtures[4].id,
      ]);
    });

    it('pages with unreadOnly=false returning all fixtures in stable total order', async () => {
      await admin.query(
        'delete from public.notifications where subject_id = $1',
        [user1Id],
      );

      const fixtures = [
        {
          id: 'f1000000-0000-4000-8000-000000000001',
          ts: '2026-09-07 10:01:00+00',
          title: 'Total Order 1',
        },
        {
          id: 'f1000000-0000-4000-8000-000000000002',
          ts: '2026-09-07 10:02:00+00',
          title: 'Total Order 2',
        },
        {
          id: 'f1000000-0000-4000-8000-000000000003',
          ts: '2026-09-07 10:03:00+00',
          title: 'Total Order 3',
        },
        {
          id: 'f1000000-0000-4000-8000-000000000004',
          ts: '2026-09-07 10:04:00+00',
          title: 'Total Order 4',
        },
        {
          id: 'f1000000-0000-4000-8000-000000000005',
          ts: '2026-09-07 10:05:00+00',
          title: 'Total Order 5',
        },
        {
          id: 'f1000000-0000-4000-8000-000000000006',
          ts: '2026-09-07 10:06:00+00',
          title: 'Total Order 6',
        },
      ];

      // Insert in shuffled order
      const shuffled = [
        fixtures[2],
        fixtures[5],
        fixtures[0],
        fixtures[4],
        fixtures[1],
        fixtures[3],
      ];
      for (const f of shuffled) {
        await admin.query(
          `insert into public.notifications (id, subject_id, type, title, read, created_at)
           values ($1, $2, 'system', $3, false, $4::timestamptz)`,
          [f.id, user1Id, f.title, f.ts],
        );
      }

      const collectedIds: string[] = [];
      let cursor: string | null = null;

      while (true) {
        const url = cursor
          ? `/v1/notifications?limit=4&unreadOnly=false&cursor=${encodeURIComponent(cursor)}`
          : '/v1/notifications?limit=4&unreadOnly=false';

        const res = await application.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${user1Token}` },
        });

        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.payload);
        for (const item of data.items) {
          collectedIds.push(item.id);
        }

        if (!data.pageInfo.hasNextPage) break;
        cursor = data.pageInfo.nextCursor;
      }

      expect(collectedIds).toHaveLength(6);
      expect(collectedIds).toEqual(fixtures.map((f) => f.id));
    });

    it('pages through rows with byte-identical created_at timestamps asserting deterministic total order and no duplicate or omission', async () => {
      await admin.query(
        'delete from public.notifications where subject_id = $1',
        [user2Id],
      );

      const fixedTimestamp = '2026-09-07 12:00:00.123456+00';
      const rowA = {
        id: '11111111-aaaa-4000-8000-000000000001',
        title: 'Tiebreak A',
      };
      const rowB = {
        id: '22222222-bbbb-4000-8000-000000000002',
        title: 'Tiebreak B',
      };
      const rowC = {
        id: '33333333-cccc-4000-8000-000000000003',
        title: 'Tiebreak C',
      };

      // Shuffled insertion order intentionally: rowC, rowA, rowB
      const shuffled = [rowC, rowA, rowB];
      for (const row of shuffled) {
        await admin.query(
          `insert into public.notifications (id, subject_id, type, title, read, created_at)
           values ($1, $2, 'system', $3, false, $4::timestamptz)`,
          [row.id, user2Id, row.title, fixedTimestamp],
        );
      }

      const collectedIds: string[] = [];
      let cursor: string | null = null;
      let pageCount = 0;

      while (true) {
        pageCount++;
        const url = cursor
          ? `/v1/notifications?limit=1&cursor=${encodeURIComponent(cursor)}`
          : '/v1/notifications?limit=1';

        const res = await application.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${user2Token}` },
        });

        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.payload);
        expect(data.items).toHaveLength(1);
        collectedIds.push(data.items[0].id);

        if (!data.pageInfo.hasNextPage) {
          expect(data.pageInfo.nextCursor).toBeNull();
          break;
        }
        expect(data.pageInfo.nextCursor).not.toBeNull();
        cursor = data.pageInfo.nextCursor;
      }

      expect(pageCount).toBe(3);
      expect(collectedIds).toEqual([rowA.id, rowB.id, rowC.id]);
    });
  });

  describe('markNotificationRead: atomic update, idempotency and conflicts', () => {
    it('marks an unread notification as read returning 204 with no content and sets read_at', async () => {
      const notifId = 'a1000000-0000-4000-8000-000000000001';
      await admin.query(
        `insert into public.notifications (id, subject_id, type, title, read, read_at)
         values ($1, $2, 'system', 'Unread Notification', false, null)
         on conflict (id) do update set read = false, read_at = null`,
        [notifId, user1Id],
      );

      const key = randomUUID();

      const response = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifId}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': key,
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');

      // Verify row state in database
      const row = await admin.query<{ read: boolean; read_at: Date }>(
        'select read, read_at from public.notifications where id = $1',
        [notifId],
      );
      expect(row.rows[0].read).toBe(true);
      expect(row.rows[0].read_at).not.toBeNull();
    });

    it('marking an already-read notification read again stays 204 and preserves read_at', async () => {
      const notifId = 'a2000000-0000-4000-8000-000000000002';
      const initialReadAt = new Date('2026-09-01T12:00:00.000Z');
      await admin.query(
        `insert into public.notifications (id, subject_id, type, title, read, read_at)
         values ($1, $2, 'system', 'Already Read Notification', true, $3)
         on conflict (id) do update set read = true, read_at = $3`,
        [notifId, user1Id, initialReadAt],
      );

      const before = await admin.query<{ read_at: Date }>(
        'select read_at from public.notifications where id = $1',
        [notifId],
      );
      const originalReadAt = before.rows[0].read_at;

      // Small delay to ensure timestamp would differ if overwritten
      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifId}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': randomUUID(),
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');

      const after = await admin.query<{ read: boolean; read_at: Date }>(
        'select read, read_at from public.notifications where id = $1',
        [notifId],
      );
      expect(after.rows[0].read).toBe(true);
      expect(after.rows[0].read_at.getTime()).toBe(originalReadAt.getTime());
    });

    it('replaying with the same idempotency key and same notificationId returns 204', async () => {
      const notifId = 'a3000000-0000-4000-8000-000000000003';
      await admin.query(
        `insert into public.notifications (id, subject_id, type, title, read, read_at)
         values ($1, $2, 'system', 'Replay Notification', false, null)
         on conflict (id) do update set read = false, read_at = null`,
        [notifId, user1Id],
      );

      const key = randomUUID();

      const first = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifId}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': key,
        },
      });
      expect(first.statusCode).toBe(204);

      const second = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifId}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': key,
        },
      });
      expect(second.statusCode).toBe(204);
    });

    it('fires 409 conflict when idempotency key is reused with a different notificationId', async () => {
      const notifA = 'a4000000-0000-4000-8000-000000000004';
      const notifB = 'a5000000-0000-4000-8000-000000000005';
      for (const [id, title] of [
        [notifA, 'Conflict Notification A'],
        [notifB, 'Conflict Notification B'],
      ] as const) {
        await admin.query(
          `insert into public.notifications (id, subject_id, type, title, read, read_at)
           values ($1, $2, 'system', $3, false, null)
           on conflict (id) do update set read = false, read_at = null`,
          [id, user1Id, title],
        );
      }

      const key = randomUUID();

      const first = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifA}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': key,
        },
      });
      expect(first.statusCode).toBe(204);

      // Same idempotency key, different notificationId in path
      const second = await application.inject({
        method: 'POST',
        url: `/v1/notifications/${notifB}/read`,
        headers: {
          authorization: `Bearer ${user1Token}`,
          'idempotency-key': key,
        },
      });
      expect(second.statusCode).toBe(409);
      const body = JSON.parse(second.payload);
      expect(body.title).toBe('Idempotency conflict');
    });
  });
});
