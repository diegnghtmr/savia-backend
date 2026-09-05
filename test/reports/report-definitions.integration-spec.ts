// Migrations under test: 202609050001_report_definitions.sql
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
if (!url) {
  throw new Error('DATABASE_URL is required for integration tests.');
}

describe('Report definitions integration suite against disposable PostgreSQL', () => {
  let admin: Pool;
  let application: NestFastifyApplication;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';
  const nonMemberId = '55555555-0000-4000-8000-000000000001';
  const dualMemberId = '66666666-0000-4000-8000-000000000001';
  const adminId = '77777777-0000-4000-8000-000000000001';

  const workspace1Id = 'aaaaaaaa-0000-4000-8000-000000000001';
  const workspace2Id = 'bbbbbbbb-0000-4000-8000-000000000001';

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    // Seed test users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'reports-owner@example.test'),
        ($2, 'reports-editor@example.test'),
        ($3, 'reports-viewer@example.test'),
        ($4, 'reports-other@example.test'),
        ($5, 'reports-nonmember@example.test'),
        ($6, 'reports-dual@example.test'),
        ($7, 'reports-admin@example.test')`,
      [
        ownerId,
        editorId,
        viewerId,
        otherOwnerId,
        nonMemberId,
        dualMemberId,
        adminId,
      ],
    );

    for (const [userId, email, name] of [
      [ownerId, 'reports-owner@example.test', 'Reports Owner'],
      [editorId, 'reports-editor@example.test', 'Reports Editor'],
      [viewerId, 'reports-viewer@example.test', 'Reports Viewer'],
      [otherOwnerId, 'reports-other@example.test', 'Reports Other Owner'],
      [nonMemberId, 'reports-nonmember@example.test', 'Reports Non Member'],
      [dualMemberId, 'reports-dual@example.test', 'Reports Dual Member'],
      [adminId, 'reports-admin@example.test', 'Reports Administrator'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (
          id, email, display_name, locale, country_code, timezone,
          date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled
        ) values (
          $1, $2, $3, 'en', 'US', 'UTC',
          'YYYY-MM-DD', 1, '1,234.56', 'USD', false
        )`,
        [userId, email, name],
      );
    }

    // Seed workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Workspace 2', 'shared', 'USD', null, $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // Seed memberships:
    // Workspace 1: owner, editor, viewer, dualMember (editor), administrator
    // Workspace 2: otherOwner (owner), dualMember (editor)
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'editor', 'active'),
        ($1, $4, 'viewer', 'active'),
        ($1, $8, 'administrator', 'active'),
        ($5, $6, 'owner', 'active'),
        ($1, $7, 'editor', 'active'),
        ($5, $7, 'editor', 'active')`,
      [
        workspace1Id,
        ownerId,
        editorId,
        viewerId,
        workspace2Id,
        otherOwnerId,
        dualMemberId,
        adminId,
      ],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: ownerId };
          if (token === 'editor-token') return { subject: editorId };
          if (token === 'viewer-token') return { subject: viewerId };
          if (token === 'other-owner-token') return { subject: otherOwnerId };
          if (token === 'non-member-token') return { subject: nonMemberId };
          if (token === 'dual-member-token') return { subject: dualMemberId };
          if (token === 'admin-token') return { subject: adminId };
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

  describe('Database schema and constraints', () => {
    it('verifies report_definitions table has forced RLS and named constraints', async () => {
      const rlsRes = await admin.query<{ rls: boolean; force: boolean }>(
        `select relrowsecurity as rls, relforcerowsecurity as force
         from pg_class where relname = 'report_definitions' and relnamespace = 'public'::regnamespace`,
      );
      expect(rlsRes.rows[0]?.rls).toBe(true);
      expect(rlsRes.rows[0]?.force).toBe(true);

      const constraintsRes = await admin.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid = 'public.report_definitions'::regclass`,
      );
      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toEqual(
        expect.arrayContaining([
          'report_definitions_workspace_id_id_key',
          'report_definitions_name_length_check',
          'report_definitions_visualization_check',
          'report_definitions_version_check',
          'report_definitions_dimensions_is_array_check',
          'report_definitions_measures_is_array_check',
          'report_definitions_measures_non_empty_check',
          'report_definitions_filters_is_object_check',
        ]),
      );

      const indexRes = await admin.query<{ indexname: string }>(
        `select indexname from pg_indexes
         where tablename = 'report_definitions' and schemaname = 'public'`,
      );
      const indexNames = indexRes.rows.map((r) => r.indexname);
      expect(indexNames).toContain(
        'report_definitions_workspace_created_at_id_idx',
      );
    });

    it('database CHECK constraint rejects empty measures array on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.report_definitions (
            workspace_id, name, dimensions, measures, visualization, created_by
          ) values ($1, 'Test', '[]'::jsonb, '[]'::jsonb, 'table', $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/report_definitions_measures_non_empty_check/);
    });

    it('database CHECK constraint rejects non-array dimensions on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.report_definitions (
            workspace_id, name, dimensions, measures, visualization, created_by
          ) values ($1, 'Test', '{"foo":"bar"}'::jsonb, '["sum"]'::jsonb, 'table', $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/report_definitions_dimensions_is_array_check/);
    });

    it('database CHECK constraint rejects non-object filters on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.report_definitions (
            workspace_id, name, dimensions, measures, visualization, filters, created_by
          ) values ($1, 'Test', '[]'::jsonb, '["sum"]'::jsonb, 'table', '["bad"]'::jsonb, $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/report_definitions_filters_is_object_check/);
    });

    it('database CHECK constraint rejects invalid visualization on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.report_definitions (
            workspace_id, name, dimensions, measures, visualization, created_by
          ) values ($1, 'Test', '[]'::jsonb, '["sum"]'::jsonb, 'invalid_viz', $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/report_definitions_visualization_check/);
    });

    it('database CHECK constraint rejects version < 1 on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.report_definitions (
            workspace_id, name, dimensions, measures, visualization, version, created_by
          ) values ($1, 'Test', '[]'::jsonb, '["sum"]'::jsonb, 'table', 0, $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/report_definitions_version_check/);
    });
  });

  describe('POST /v1/report-definitions', () => {
    const validPayload = {
      name: 'Monthly Income by Category',
      dimensions: ['month', 'category'],
      measures: ['sum'],
      visualization: 'bar',
      filters: { type: 'income' },
    };

    it('returns 401 when request is unauthenticated', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: validPayload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user is not a member of workspace', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: validPayload,
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 403 when user has viewer role', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: validPayload,
      });
      expect(response.statusCode).toBe(403);
    });

    it('exercises owner, administrator, editor, and viewer at create endpoint boundary', async () => {
      for (const [token, expectedStatus] of [
        ['owner-token', 201],
        ['admin-token', 201],
        ['editor-token', 201],
        ['viewer-token', 403],
      ] as const) {
        const response = await application.inject({
          method: 'POST',
          url: '/v1/report-definitions',
          headers: {
            authorization: `Bearer ${token}`,
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: { ...validPayload, name: `Report for ${token}` },
        });
        expect(response.statusCode).toBe(expectedStatus);
      }
    });

    it('returns 400 when X-Workspace-Id header is missing or invalid', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'idempotency-key': randomUUID(),
        },
        payload: validPayload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when Idempotency-Key header is missing or invalid', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
        payload: validPayload,
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 422 when name is empty', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, name: '' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('accepts name with exactly 120 astral characters and rejects 121 astral characters', async () => {
      const astralChar = '🚀'; // 1 code point, 2 UTF-16 code units
      const name120 = astralChar.repeat(120);
      const name121 = astralChar.repeat(121);

      // 120 emojis: accepted
      const res120 = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, name: name120 },
      });
      expect(res120.statusCode).toBe(201);
      const created120 = res120.json();
      expect(created120.name).toBe(name120);

      // 121 emojis: 422
      const res121 = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, name: name121 },
      });
      expect(res121.statusCode).toBe(422);
    });

    it('returns 422 when measures is empty', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, measures: [] },
      });
      expect(response.statusCode).toBe(422);
    });

    it('returns 422 when dimensions or measures contains invalid enum item', async () => {
      const resDim = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, dimensions: ['invalid_dim'] },
      });
      expect(resDim.statusCode).toBe(422);

      const resMeas = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, measures: ['invalid_meas'] },
      });
      expect(resMeas.statusCode).toBe(422);
    });

    it('returns 422 when visualization is invalid', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, visualization: 'unknown' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('returns 422 when filters is not an object', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, filters: 'string-filter' },
      });
      expect(response.statusCode).toBe(422);
    });

    it('returns 422 when unknown top-level field is passed', async () => {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { ...validPayload, unexpected: true },
      });
      expect(response.statusCode).toBe(422);
    });

    it('preserves order and duplicates in dimensions and measures', async () => {
      // Shuffled fixture with intentional duplicates
      const shuffledPayload = {
        name: 'Order and Duplicates Test',
        dimensions: ['month', 'date', 'month', 'category'],
        measures: ['variance', 'sum', 'variance', 'count'],
        visualization: 'pivot',
      };

      const key = randomUUID();
      const response = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: shuffledPayload,
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.dimensions).toEqual(['month', 'date', 'month', 'category']);
      expect(body.measures).toEqual(['variance', 'sum', 'variance', 'count']);
      expect(body.visualization).toBe('pivot');
      expect(body.filters).toEqual({});
      expect(body.version).toBe(1);
    });

    it('defaults filters to {} when omitted, and preserves custom filters verbatim', async () => {
      const key1 = randomUUID();
      const resNoFilters = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key1,
        },
        payload: {
          name: 'No Filters Report',
          dimensions: ['date'],
          measures: ['count'],
          visualization: 'kpi',
        },
      });
      expect(resNoFilters.statusCode).toBe(201);
      expect(resNoFilters.json().filters).toEqual({});

      const key2 = randomUUID();
      const customFilters = {
        status: ['confirmed', 'reconciled'],
        threshold: 1000,
        nested: { tags: ['urgent'] },
      };
      const resWithFilters = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key2,
        },
        payload: {
          name: 'With Custom Filters',
          dimensions: ['date'],
          measures: ['count'],
          visualization: 'kpi',
          filters: customFilters,
        },
      });
      expect(resWithFilters.statusCode).toBe(201);
      expect(resWithFilters.json().filters).toEqual(customFilters);
    });

    it('replays response for same idempotency key and returns 409 conflict for different payload', async () => {
      const key = randomUUID();
      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: validPayload,
      });
      expect(res1.statusCode).toBe(201);
      const created = res1.json();

      // Same key, same payload -> replayed (201)
      const resReplay = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: validPayload,
      });
      expect(resReplay.statusCode).toBe(201);
      expect(resReplay.json()).toEqual(created);

      // Same key, different payload -> 409 conflict
      const resConflict = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: { ...validPayload, name: 'Different Name Conflict' },
      });
      expect(resConflict.statusCode).toBe(409);
    });
  });

  describe('GET /v1/report-definitions', () => {
    it('returns 401 when request is unauthenticated', async () => {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/report-definitions',
        headers: { 'x-workspace-id': workspace1Id },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user is non-member of workspace', async () => {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('allows viewer role to list report definitions', async () => {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.pageInfo).toBeDefined();
    });

    it('exercises owner, administrator, editor, and viewer at list endpoint boundary', async () => {
      for (const token of [
        'owner-token',
        'admin-token',
        'editor-token',
        'viewer-token',
      ] as const) {
        const response = await application.inject({
          method: 'GET',
          url: '/v1/report-definitions',
          headers: {
            authorization: `Bearer ${token}`,
            'x-workspace-id': workspace1Id,
          },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.pageInfo).toBeDefined();
      }
    });

    it('supports cursor pagination across items', async () => {
      // Create distinct items in workspace1
      for (let i = 1; i <= 3; i++) {
        await application.inject({
          method: 'POST',
          url: '/v1/report-definitions',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            name: `Pagination Test Report ${i}`,
            dimensions: ['year'],
            measures: ['sum'],
            visualization: 'table',
          },
        });
      }

      // First page with limit 2
      const page1Res = await application.inject({
        method: 'GET',
        url: '/v1/report-definitions?limit=2',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json();
      expect(page1.items).toHaveLength(2);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(page1.pageInfo.nextCursor).toBeTypeOf('string');

      // Second page with cursor
      const page2Res = await application.inject({
        method: 'GET',
        url: `/v1/report-definitions?limit=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json();
      expect(page2.items.length).toBeGreaterThanOrEqual(1);
    });

    it('strictly isolates items between workspaces using dual-workspace-member fixture', async () => {
      // dualMemberId has editor role in BOTH workspace1 and workspace2.
      // RLS allows dualMemberId to select rows in both workspace1 and workspace2.
      // Only the SQL query predicate `workspace_id = $1::uuid` enforces that
      // querying workspace1 returns ONLY workspace1 items.
      const uniqueWs1Name = `WS1-Unique-${randomUUID()}`;
      const uniqueWs2Name = `WS2-Unique-${randomUUID()}`;

      // Create item in workspace 1
      const resWs1 = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: uniqueWs1Name,
          dimensions: ['month'],
          measures: ['count'],
          visualization: 'bar',
        },
      });
      expect(resWs1.statusCode).toBe(201);

      // Create item in workspace 2
      const resWs2 = await application.inject({
        method: 'POST',
        url: '/v1/report-definitions',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: uniqueWs2Name,
          dimensions: ['month'],
          measures: ['count'],
          visualization: 'bar',
        },
      });
      expect(resWs2.statusCode).toBe(201);

      // Dual member lists workspace 1
      const listWs1 = await application.inject({
        method: 'GET',
        url: '/v1/report-definitions?limit=200',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(listWs1.statusCode).toBe(200);
      const ws1Items = listWs1.json().items;
      const ws1Names = ws1Items.map((it: { name: string }) => it.name);

      expect(ws1Names).toContain(uniqueWs1Name);
      expect(ws1Names).not.toContain(uniqueWs2Name);

      // Dual member lists workspace 2
      const listWs2 = await application.inject({
        method: 'GET',
        url: '/v1/report-definitions?limit=200',
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
        },
      });
      expect(listWs2.statusCode).toBe(200);
      const ws2Items = listWs2.json().items;
      const ws2Names = ws2Items.map((it: { name: string }) => it.name);

      expect(ws2Names).toContain(uniqueWs2Name);
      expect(ws2Names).not.toContain(uniqueWs1Name);
    });
  });
});
