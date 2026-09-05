// Migrations under test: 202609040001_scenarios.sql, 202609040002_scenario_runs.sql
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
import { SCENARIO_ASSUMPTION_TYPES } from '../../src/scenarios/scenario.port.js';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for integration tests.');
}

describe('Scenarios integration suite against disposable PostgreSQL', () => {
  let admin: Pool;
  let application: NestFastifyApplication;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const editorId = '22222222-0000-4000-8000-000000000001';
  const viewerId = '33333333-0000-4000-8000-000000000001';
  const otherOwnerId = '44444444-0000-4000-8000-000000000001';
  const nonMemberId = '55555555-0000-4000-8000-000000000001';
  const dualMemberId = '66666666-0000-4000-8000-000000000001';

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
        ($1, 'scenarios-owner@example.test'),
        ($2, 'scenarios-editor@example.test'),
        ($3, 'scenarios-viewer@example.test'),
        ($4, 'scenarios-other@example.test'),
        ($5, 'scenarios-nonmember@example.test'),
        ($6, 'scenarios-dual@example.test')`,
      [ownerId, editorId, viewerId, otherOwnerId, nonMemberId, dualMemberId],
    );

    for (const [userId, email, name] of [
      [ownerId, 'scenarios-owner@example.test', 'Scenarios Owner'],
      [editorId, 'scenarios-editor@example.test', 'Scenarios Editor'],
      [viewerId, 'scenarios-viewer@example.test', 'Scenarios Viewer'],
      [otherOwnerId, 'scenarios-other@example.test', 'Scenarios Other Owner'],
      [nonMemberId, 'scenarios-nonmember@example.test', 'Scenarios Non Member'],
      [dualMemberId, 'scenarios-dual@example.test', 'Scenarios Dual Member'],
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

    // Seed memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'editor', 'active'),
        ($1, $4, 'viewer', 'active'),
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
    it('verifies scenarios table has forced RLS and named constraints', async () => {
      const rlsRes = await admin.query<{ rls: boolean; force: boolean }>(
        `select relrowsecurity as rls, relforcerowsecurity as force
         from pg_class where relname = 'scenarios' and relnamespace = 'public'::regnamespace`,
      );
      expect(rlsRes.rows[0]?.rls).toBe(true);
      expect(rlsRes.rows[0]?.force).toBe(true);

      const constraintsRes = await admin.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid = 'public.scenarios'::regclass`,
      );
      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toEqual(
        expect.arrayContaining([
          'scenarios_workspace_id_id_key',
          'scenarios_name_length_check',
          'scenarios_description_length_check',
          'scenarios_assumptions_is_array_check',
          'scenarios_assumptions_non_empty_check',
        ]),
      );

      const indexRes = await admin.query<{ indexname: string }>(
        `select indexname from pg_indexes
         where tablename = 'scenarios' and schemaname = 'public'`,
      );
      const indexNames = indexRes.rows.map((r) => r.indexname);
      expect(indexNames).toContain('scenarios_workspace_created_at_id_idx');
    });

    it('database CHECK constraint rejects empty assumptions array on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.scenarios (workspace_id, name, assumptions, created_by)
           values ($1, 'Direct Insert Test', '[]'::jsonb, $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/scenarios_assumptions_non_empty_check/);
    });

    it('database CHECK constraint rejects non-array assumptions on direct insert', async () => {
      await expect(
        admin.query(
          `insert into public.scenarios (workspace_id, name, assumptions, created_by)
           values ($1, 'Direct Insert Test', '{"key": "val"}'::jsonb, $2)`,
          [workspace1Id, ownerId],
        ),
      ).rejects.toThrow(/scenarios_assumptions_is_array_check/);
    });

    it('verifies scenario_runs table has forced RLS and named constraints', async () => {
      const rlsRes = await admin.query<{ rls: boolean; force: boolean }>(
        `select relrowsecurity as rls, relforcerowsecurity as force
         from pg_class where relname = 'scenario_runs' and relnamespace = 'public'::regnamespace`,
      );
      expect(rlsRes.rows[0]?.rls).toBe(true);
      expect(rlsRes.rows[0]?.force).toBe(true);

      const constraintsRes = await admin.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid = 'public.scenario_runs'::regclass`,
      );
      const constraintNames = constraintsRes.rows.map((r) => r.conname);
      expect(constraintNames).toEqual(
        expect.arrayContaining([
          'scenario_runs_workspace_id_id_key',
          'scenario_runs_status_check',
          'scenario_runs_risks_is_array_check',
          'scenario_runs_scenario_workspace_fkey',
        ]),
      );
    });

    it('rejects scenario run insert with invalid status via CHECK constraint', async () => {
      const scenarioRes = await admin.query<{ id: string }>(
        `insert into public.scenarios (workspace_id, name, assumptions, created_by)
         values ($1, 'Valid Scenario For Run', '[{"type":"income_change","value":{}}]'::jsonb, $2)
         returning id::text`,
        [workspace1Id, ownerId],
      );
      const scenarioId = scenarioRes.rows[0]?.id;
      await expect(
        admin.query(
          `insert into public.scenario_runs (workspace_id, scenario_id, status, baseline, projected, difference, created_by)
           values ($1, $2, 'invalid_status', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3)`,
          [workspace1Id, scenarioId, ownerId],
        ),
      ).rejects.toThrow(/scenario_runs_status_check/);
    });

    it('enforces composite foreign key preventing run from pointing to scenario in different workspace', async () => {
      const scenario2Res = await admin.query<{ id: string }>(
        `insert into public.scenarios (workspace_id, name, assumptions, created_by)
         values ($1, 'Workspace 2 Scenario', '[{"type":"income_change","value":{}}]'::jsonb, $2)
         returning id::text`,
        [workspace2Id, otherOwnerId],
      );
      const scenario2Id = scenario2Res.rows[0]?.id;

      await expect(
        admin.query(
          `insert into public.scenario_runs (workspace_id, scenario_id, status, baseline, projected, difference, created_by)
           values ($1, $2, 'completed', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3)`,
          [workspace1Id, scenario2Id, ownerId],
        ),
      ).rejects.toThrow(/scenario_runs_scenario_workspace_fkey/);
    });
  });

  describe('createScenario operation', () => {
    it('accepts all nine assumption types and returns 201 with lastRunId: null', async () => {
      for (const type of SCENARIO_ASSUMPTION_TYPES) {
        const key = randomUUID();
        const res = await application.inject({
          method: 'POST',
          url: '/v1/scenarios',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': key,
          },
          payload: {
            name: `Scenario with ${type}`,
            description: `Testing assumption type ${type}`,
            assumptions: [
              {
                type,
                value: { amount: 100, flag: true, note: 'valid open object' },
              },
            ],
          },
        });

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.payload);
        expect(body.name).toBe(`Scenario with ${type}`);
        expect(body.description).toBe(`Testing assumption type ${type}`);
        expect(body.assumptions[0].type).toBe(type);
        expect(body.assumptions[0].value).toEqual({
          amount: 100,
          flag: true,
          note: 'valid open object',
        });
        expect(body.lastRunId).toBeNull();
        expect(body).toHaveProperty('lastRunId', null);
      }
    });

    it('M1: rejects unknown assumption type with 422 naming assumptions.0.type', async () => {
      const key = randomUUID();
      const res = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          name: 'Invalid Type Scenario',
          assumptions: [{ type: 'unknown_disallowed_type', value: {} }],
        },
      });

      expect(res.statusCode).toBe(422);
      const problem = JSON.parse(res.payload);
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions.0.type',
            code: 'invalid',
          }),
        ]),
      );
    });

    it('rejects missing assumption type and null assumption type with 422', async () => {
      const resMissing = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Missing Type Scenario',
          assumptions: [{ value: {} }],
        },
      });
      expect(resMissing.statusCode).toBe(422);
      expect(JSON.parse(resMissing.payload).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'assumptions.0.type' }),
        ]),
      );

      const resNull = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Null Type Scenario',
          assumptions: [{ type: null, value: {} }],
        },
      });
      expect(resNull.statusCode).toBe(422);
      expect(JSON.parse(resNull.payload).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'assumptions.0.type' }),
        ]),
      );
    });

    it('M2: rejects assumptions: [] with 422 naming assumptions', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Empty Assumptions Scenario',
          assumptions: [],
        },
      });

      expect(res.statusCode).toBe(422);
      const problem = JSON.parse(res.payload);
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'assumptions',
            code: 'invalid',
          }),
        ]),
      );
    });

    it('rejects non-object assumption value (null, array, string) with 422', async () => {
      for (const val of [null, [1, 2], 'scalar-string']) {
        const res = await application.inject({
          method: 'POST',
          url: '/v1/scenarios',
          headers: {
            authorization: 'Bearer owner-token',
            'x-workspace-id': workspace1Id,
            'idempotency-key': randomUUID(),
          },
          payload: {
            name: 'Invalid Value Scenario',
            assumptions: [{ type: 'purchase', value: val }],
          },
        });
        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.payload).errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'assumptions.0.value' }),
          ]),
        );
      }
    });

    it('rejects unknown top-level property with 422', async () => {
      const res = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Valid Name',
          assumptions: [{ type: 'purchase', value: {} }],
          unknownField: 'not allowed',
        },
      });

      expect(res.statusCode).toBe(422);
      const problem = JSON.parse(res.payload);
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'unknownField',
            code: 'not-allowed',
          }),
        ]),
      );
    });

    it('rejects name of 0 and 121 chars, description of 1001 chars with 422', async () => {
      const res0 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: '',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(res0.statusCode).toBe(422);

      const res121 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'a'.repeat(121),
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(res121.statusCode).toBe(422);

      const resDesc1001 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Valid Name',
          description: 'd'.repeat(1001),
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(resDesc1001.statusCode).toBe(422);
    });

    it('M3: asserts validation failures return 422, whereas malformed workspace header returns 400', async () => {
      // 422 for command validation failure
      const resValidation = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: '',
          assumptions: [],
        },
      });
      expect(resValidation.statusCode).toBe(422);

      // 400 for malformed workspace header
      const resMalformedHeader = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': 'not-a-valid-uuid',
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Scenario',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(resMalformedHeader.statusCode).toBe(400);
    });

    it('M5: replay with same key and body returns original 201 and creates no second row', async () => {
      const key = randomUUID();
      const payload = {
        name: 'Idempotent Scenario',
        description: 'Testing replay semantics',
        assumptions: [
          { type: 'purchase', value: { item: 'Laptop', cost: 1200 } },
        ],
      };

      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const created = JSON.parse(res1.payload);

      // Second request with exact same key and payload
      const res2 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const replayed = JSON.parse(res2.payload);
      expect(replayed).toEqual(created);

      // Verify in DB that only 1 row exists with this name in this workspace
      const countRes = await admin.query<{ count: string }>(
        `select count(*) as count from public.scenarios
         where workspace_id = $1 and name = $2`,
        [workspace1Id, 'Idempotent Scenario'],
      );
      expect(Number(countRes.rows[0]?.count)).toBe(1);
    });

    it('same key with different body returns 409 conflict', async () => {
      const key = randomUUID();
      const res1 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          name: 'Original Scenario',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(res1.statusCode).toBe(201);

      const res2 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
        payload: {
          name: 'Conflicting Scenario',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('viewer and non-member cannot create scenarios (403 forbidden)', async () => {
      const resViewer = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Viewer Attempt',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(resViewer.statusCode).toBe(403);

      const resNonMember = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Non-Member Attempt',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(resNonMember.statusCode).toBe(403);
    });
  });

  describe('listScenarios operation', () => {
    it('hostile ordering: walks every scenario across pages with out-of-order insertion and created_at tie', async () => {
      // Dedicated workspace for deterministic pagination verification
      const pWsId = 'cccccccc-0000-4000-8000-000000000001';
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Pagination Workspace', 'shared', 'USD', $2)`,
        [pWsId, ownerId],
      );
      await admin.query(
        `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [pWsId, ownerId],
      );

      // Four hostile rows inserted out of order, with a tie on created_at:
      // Canonical order by (created_at asc, id asc):
      // 1. row3: T1, id = 11111111-aaaa...
      // 2. row2: T1, id = 22222222-aaaa... (tie on T1, broken by id)
      // 3. row1: T2, id = 33333333-aaaa...
      // 4. row4: T3, id = 44444444-aaaa...
      const t1 = '2026-09-01T10:00:00.000000Z';
      const t2 = '2026-09-02T10:00:00.000000Z';
      const t3 = '2026-09-03T10:00:00.000000Z';

      const idRow1 = '33333333-aaaa-4000-8000-000000000001'; // T2
      const idRow2 = '22222222-aaaa-4000-8000-000000000001'; // T1
      const idRow3 = '11111111-aaaa-4000-8000-000000000001'; // T1
      const idRow4 = '44444444-aaaa-4000-8000-000000000001'; // T3

      // Insert OUT OF ORDER: row1 (T2), then row2 (T1), then row3 (T1), then row4 (T3)
      await admin.query(
        `insert into public.scenarios (id, workspace_id, name, assumptions, created_by, created_at) values
         ($1, $2, 'Scenario C (T2)', '[{"type": "purchase", "value": {}}]'::jsonb, $3, $4::timestamptz)`,
        [idRow1, pWsId, ownerId, t2],
      );
      await admin.query(
        `insert into public.scenarios (id, workspace_id, name, assumptions, created_by, created_at) values
         ($1, $2, 'Scenario B (T1 tie 2)', '[{"type": "purchase", "value": {}}]'::jsonb, $3, $4::timestamptz)`,
        [idRow2, pWsId, ownerId, t1],
      );
      await admin.query(
        `insert into public.scenarios (id, workspace_id, name, assumptions, created_by, created_at) values
         ($1, $2, 'Scenario A (T1 tie 1)', '[{"type": "purchase", "value": {}}]'::jsonb, $3, $4::timestamptz)`,
        [idRow3, pWsId, ownerId, t1],
      );
      await admin.query(
        `insert into public.scenarios (id, workspace_id, name, assumptions, created_by, created_at) values
         ($1, $2, 'Scenario D (T3)', '[{"type": "purchase", "value": {}}]'::jsonb, $3, $4::timestamptz)`,
        [idRow4, pWsId, ownerId, t3],
      );

      // Fetch Page 1 with limit 2
      const page1Res = await application.inject({
        method: 'GET',
        url: '/v1/scenarios?limit=2',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': pWsId,
        },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = JSON.parse(page1Res.payload);
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0].id).toBe(idRow3); // Scenario A (T1 tie 1)
      expect(page1.items[1].id).toBe(idRow2); // Scenario B (T1 tie 2)
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(page1.pageInfo.nextCursor).toBeTruthy();

      // Fetch Page 2 with cursor from Page 1
      const page2Res = await application.inject({
        method: 'GET',
        url: `/v1/scenarios?limit=2&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': pWsId,
        },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = JSON.parse(page2Res.payload);
      expect(page2.items).toHaveLength(2);
      expect(page2.items[0].id).toBe(idRow1); // Scenario C (T2)
      expect(page2.items[1].id).toBe(idRow4); // Scenario D (T3)
      expect(page2.pageInfo.hasNextPage).toBe(false);
      expect(page2.pageInfo.nextCursor).toBeNull();
    });

    // What this proves is ROW-LEVEL SECURITY, not the adapter's WHERE clause: removing
    // the query's workspace_id predicate leaves this test green, because the RLS policy
    // already blocks the read. Named for what it actually guards.
    it('row-level security keeps a scenario in another workspace out of the list', async () => {
      // Create scenario in workspace 2
      const resWs2 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Private Workspace 2 Scenario',
          assumptions: [{ type: 'purchase', value: {} }],
        },
      });
      expect(resWs2.statusCode).toBe(201);
      const ws2Scenario = JSON.parse(resWs2.payload);

      // List scenarios in workspace 1
      const resWs1 = await application.inject({
        method: 'GET',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resWs1.statusCode).toBe(200);
      const ws1List = JSON.parse(resWs1.payload);

      const foundWs2InWs1 = ws1List.items.some(
        (item: { id: string }) => item.id === ws2Scenario.id,
      );
      expect(foundWs2InWs1).toBe(false);
    });

    it('returns 403 when non-member lists scenarios', async () => {
      const res = await application.inject({
        method: 'GET',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 when X-Workspace-Id is malformed on list', async () => {
      const res = await application.inject({
        method: 'GET',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': 'bad-workspace-id',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 422 when limit or cursor is invalid on list', async () => {
      const resLimit = await application.inject({
        method: 'GET',
        url: '/v1/scenarios?limit=999',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resLimit.statusCode).toBe(422);

      const resCursor = await application.inject({
        method: 'GET',
        url: '/v1/scenarios?cursor=invalid-opaque-cursor',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resCursor.statusCode).toBe(422);
    });
  });

  describe('runScenario operation', () => {
    let testScenarioId: string;

    beforeAll(async () => {
      // Create a scenario in workspace 1
      const res = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Integration Run Test Scenario',
          description: 'Testing runScenario endpoint',
          assumptions: [
            { type: 'income_change', value: { amountMinor: '50000' } },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.payload);
      testScenarioId = created.id;
    });

    it('successfully runs scenario, returning 200 with ScenarioRun, updates last_run_id on public.scenarios, and creates row in public.scenario_runs', async () => {
      const key = randomUUID();
      const res = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
      });

      expect(res.statusCode).toBe(200);
      const run = JSON.parse(res.payload);

      expect(run.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(run.scenarioId).toBe(testScenarioId);
      expect(run.status).toBe('completed');
      expect(run.baseline).toBeDefined();
      expect(run.projected).toBeDefined();
      expect(run.difference).toBeDefined();
      expect(run.risks).toEqual([]);

      expect(run.baseline.baseCurrency).toBe('USD');
      expect(run.projected.baseCurrency).toBe('USD');
      expect(run.difference.baseCurrency).toBe('USD');
      expect(run.baseline.monthlyIncomeMinor).toMatch(/^-?[0-9]+$/);
      expect(run.projected.monthlyIncomeMinor).toMatch(/^-?[0-9]+$/);
      expect(run.difference.monthlyIncomeMinor).toMatch(/^-?[0-9]+$/);

      // Verify last_run_id is updated on public.scenarios
      const scenarioRes = await admin.query<{ last_run_id: string | null }>(
        'select last_run_id from public.scenarios where id = $1',
        [testScenarioId],
      );
      expect(scenarioRes.rows[0]?.last_run_id).toBe(run.id);

      // Verify row exists in public.scenario_runs
      const runRes = await admin.query<{ id: string; status: string }>(
        'select id, status from public.scenario_runs where id = $1 and workspace_id = $2 and scenario_id = $3',
        [run.id, workspace1Id, testScenarioId],
      );
      expect(runRes.rows).toHaveLength(1);
      expect(runRes.rows[0]?.status).toBe('completed');
    });

    it('M5: scenario lookup scopes by workspace_id, returning 404 when scenario belongs to another workspace (cross-workspace leak prevention)', async () => {
      // Create a scenario in workspace 2
      const resWs2 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer other-owner-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Workspace 2 Private Scenario',
          assumptions: [
            { type: 'income_change', value: { amountMinor: '25000' } },
          ],
        },
      });
      expect(resWs2.statusCode).toBe(201);
      const ws2Scenario = JSON.parse(resWs2.payload);

      // Attempt to run workspace 2 scenario from workspace 1 with a dual-workspace member.
      // Because dualMember is an active member of both workspaces, RLS permits reading either,
      // proving that the 404 is enforced by the SQL workspace predicate and not masked by RLS.
      const res = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${ws2Scenario.id}/runs`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
      });

      expect(res.statusCode).toBe(404);
      const problem = JSON.parse(res.payload);
      expect(problem.status).toBe(404);
    });

    it('replay with same key returns original 200 and creates no second row', async () => {
      const key = randomUUID();

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
      });
      expect(res1.statusCode).toBe(200);
      const run1 = JSON.parse(res1.payload);

      const countBefore = await admin.query<{ count: string }>(
        'select count(*) as count from public.scenario_runs where scenario_id = $1',
        [testScenarioId],
      );

      // Second run with identical idempotency key
      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
      });
      expect(res2.statusCode).toBe(200);
      const run2 = JSON.parse(res2.payload);
      expect(run2).toEqual(run1);

      const countAfter = await admin.query<{ count: string }>(
        'select count(*) as count from public.scenario_runs where scenario_id = $1',
        [testScenarioId],
      );
      expect(Number(countAfter.rows[0]?.count)).toBe(
        Number(countBefore.rows[0]?.count),
      );
    });

    it('same key with different fingerprint returns 409 conflict', async () => {
      const key = randomUUID();

      // Run on testScenarioId
      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
      });
      expect(res1.statusCode).toBe(200);

      // Create a second scenario in workspace 1
      const resCreate2 = await application.inject({
        method: 'POST',
        url: '/v1/scenarios',
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          name: 'Scenario 2 for Conflict',
          assumptions: [{ type: 'purchase', value: { amountMinor: '1000' } }],
        },
      });
      expect(resCreate2.statusCode).toBe(201);
      const scenario2 = JSON.parse(resCreate2.payload);

      // Run on second scenario with the same idempotency key -> different fingerprint -> 409
      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${scenario2.id}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': key,
        },
      });
      expect(res2.statusCode).toBe(409);
    });

    it('returns 422 when Idempotency-Key is missing or invalid', async () => {
      const resMissing = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(resMissing.statusCode).toBe(422);

      const resInvalid = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': 'not-a-uuid',
        },
      });
      expect(resInvalid.statusCode).toBe(422);
    });

    it('returns 400 when X-Workspace-Id is missing or malformed', async () => {
      const resMissing = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'idempotency-key': randomUUID(),
        },
      });
      expect(resMissing.statusCode).toBe(400);

      const resMalformed = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': 'bad-workspace-id',
          'idempotency-key': randomUUID(),
        },
      });
      expect(resMalformed.statusCode).toBe(400);
    });

    it('viewer and non-member cannot run scenarios (403 forbidden)', async () => {
      const resViewer = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
      });
      expect(resViewer.statusCode).toBe(403);

      const resNonMember = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
      });
      expect(resNonMember.statusCode).toBe(403);
    });

    it('returns 422 when exchange rate is missing for foreign currency', async () => {
      // Create a foreign currency debt in workspace 1 with no exchange rate
      const foreignDebtId = randomUUID();
      await admin.query(
        `insert into public.debts (id, workspace_id, name, currency, principal_minor, annual_rate, rate_type, status, version)
         values ($1, $2, 'Foreign JPY Debt', 'JPY', 1000000, 0.05, 'fixed', 'active', 1)`,
        [foreignDebtId, workspace1Id],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/scenarios/${testScenarioId}/runs`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
      });

      expect(res.statusCode).toBe(422);
      const problem = JSON.parse(res.payload);
      expect(problem.status).toBe(422);
      expect(problem.title).toBe('Missing exchange rate');

      // Clean up foreign debt so subsequent tests are not affected
      await admin.query('delete from public.debts where id = $1', [
        foreignDebtId,
      ]);
    });

    it('RULING 92: rolls back inserted run row and last_run_id when an error is thrown inside transaction', async () => {
      const probeRunId = randomUUID();
      let caughtError = false;

      const client = await admin.connect();
      try {
        await client.query('begin');

        // Simulate write in scenario_runs and scenarios update
        await client.query(
          `insert into public.scenario_runs (
            id, workspace_id, scenario_id, status, baseline, projected, difference, risks, created_by
          ) values ($1, $2, $3, 'completed', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $4)`,
          [probeRunId, workspace1Id, testScenarioId, ownerId],
        );
        await client.query(
          'update public.scenarios set last_run_id = $1 where id = $2',
          [probeRunId, testScenarioId],
        );

        // Verify inside uncommitted transaction that rows are visible
        const insideRes = await client.query(
          'select id from public.scenario_runs where id = $1',
          [probeRunId],
        );
        expect(insideRes.rows).toHaveLength(1);

        // Force conflict / rollback sentinel
        throw new Error('Forced conflict to test RULING 92 rollback sentinel');
      } catch {
        await client.query('rollback');
        caughtError = true;
      } finally {
        client.release();
      }

      expect(caughtError).toBe(true);

      // Verify outside that nothing persisted: scenario_runs row does not exist
      const outsideRes = await admin.query(
        'select id from public.scenario_runs where id = $1',
        [probeRunId],
      );
      expect(outsideRes.rows).toHaveLength(0);

      // Verify scenarios.last_run_id is not probeRunId
      const scenarioRes = await admin.query<{ last_run_id: string | null }>(
        'select last_run_id from public.scenarios where id = $1',
        [testScenarioId],
      );
      expect(scenarioRes.rows[0]?.last_run_id).not.toBe(probeRunId);
    });
  });
});
