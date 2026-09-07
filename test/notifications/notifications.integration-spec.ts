// Migration under test: 202609060003_notifications.sql
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';

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

    it('enforces notifications_type_check constraint', async () => {
      await expect(
        admin.query(
          `insert into public.notifications (subject_id, type, title)
           values ($1, 'invalid_type_vocabulary', 'Test Title')`,
          [user1Id],
        ),
      ).rejects.toThrow(/notifications_type_check/);
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
      expect(collectedIds).toEqual([
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000003',
        '40000000-0000-4000-8000-000000000004',
        '50000000-0000-4000-8000-000000000005',
        '60000000-0000-4000-8000-000000000006',
      ]);
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
      const notifId = '10000000-0000-4000-8000-000000000001';
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
      const notifId = '10000000-0000-4000-8000-000000000001';
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
      const notifId = '30000000-0000-4000-8000-000000000003';
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
      const key = randomUUID();
      const notifA = '30000000-0000-4000-8000-000000000003';
      const notifB = '50000000-0000-4000-8000-000000000005';

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
