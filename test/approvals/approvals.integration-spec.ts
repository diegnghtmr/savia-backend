// Migration under test: 202609060001_approvals.sql
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

describe('Approvals integration contract and endpoint suite', () => {
  let admin: Pool;
  let application: NestFastifyApplication;

  const ownerId = '11111111-0000-4000-8000-000000000001';
  const adminId = '77777777-0000-4000-8000-000000000001';
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

    // 1. Seed auth users & profiles
    await admin.query(
      `insert into auth.users (id, email) values
        ($1, 'approvals-owner@example.test'),
        ($2, 'approvals-admin@example.test'),
        ($3, 'approvals-editor@example.test'),
        ($4, 'approvals-viewer@example.test'),
        ($5, 'approvals-other@example.test'),
        ($6, 'approvals-nonmember@example.test'),
        ($7, 'approvals-dual@example.test')`,
      [
        ownerId,
        adminId,
        editorId,
        viewerId,
        otherOwnerId,
        nonMemberId,
        dualMemberId,
      ],
    );

    for (const [userId, email, name] of [
      [ownerId, 'approvals-owner@example.test', 'Approvals Owner'],
      [adminId, 'approvals-admin@example.test', 'Approvals Administrator'],
      [editorId, 'approvals-editor@example.test', 'Approvals Editor'],
      [viewerId, 'approvals-viewer@example.test', 'Approvals Viewer'],
      [otherOwnerId, 'approvals-other@example.test', 'Approvals Other Owner'],
      [nonMemberId, 'approvals-nonmember@example.test', 'Approvals Non Member'],
      [dualMemberId, 'approvals-dual@example.test', 'Approvals Dual Member'],
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

    // 2. Seed workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by) values
        ($1, 'Workspace 1', 'shared', 'USD', null, $2),
        ($3, 'Workspace 2', 'shared', 'USD', null, $4)`,
      [workspace1Id, ownerId, workspace2Id, otherOwnerId],
    );

    // 3. Seed memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values
        ($1, $2, 'owner', 'active'),
        ($1, $3, 'administrator', 'active'),
        ($1, $4, 'editor', 'active'),
        ($1, $5, 'viewer', 'active'),
        ($1, $6, 'administrator', 'active'),
        ($7, $8, 'owner', 'active'),
        ($7, $6, 'administrator', 'active')`,
      [
        workspace1Id,
        ownerId,
        adminId,
        editorId,
        viewerId,
        dualMemberId,
        workspace2Id,
        otherOwnerId,
      ],
    );

    // Bootstrap Nest application
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue({
        verify: async (token: string) => {
          if (token === 'owner-token') return { subject: ownerId };
          if (token === 'admin-token') return { subject: adminId };
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
    it('has the approvals table and constraints installed', async () => {
      const result = await admin.query<{
        constraintName: string;
      }>(
        `select con.conname as "constraintName"
           from pg_class c join pg_constraint con on con.conrelid = c.oid
          where c.relname = 'approvals'
          order by con.conname`,
      );
      const names = result.rows.map((r) => r.constraintName);
      expect(names).toContain('approvals_risk_class_check');
      expect(names).toContain('approvals_status_check');
      expect(names).toContain('approvals_preview_is_object_check');
      expect(names).toContain('approvals_decided_state_check');
      expect(names).toContain('approvals_workspace_id_id_key');
    });
  });

  describe('argumentsHash verification', () => {
    it('rejects confirmApproval with 409 Conflict when argumentsHash does not match stored hash', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'sha256-correct-hash', '{"symbol": "AAPL"}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: 'sha256-wrong-hash',
        },
      });

      expect(res.statusCode).toBe(409);
    });

    it('rejects rejectApproval with 409 Conflict when argumentsHash does not match stored hash', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'sha256-correct-hash', '{"symbol": "AAPL"}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: 'sha256-wrong-hash',
        },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('Non-pending status rejection', () => {
    it('rejects decision with 409 Conflict when approval status is approved', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, decided_by, decided_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'approved', now() + interval '1 day', $3, now(), $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects decision with 409 Conflict when approval status is rejected', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, decided_by, decided_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'rejected', now() + interval '1 day', $3, now(), $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects decision with 409 Conflict when approval status is expired', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'expired', now() - interval '1 hour', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects decision with 409 Conflict when approval status is consumed', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'consumed', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('Read-time expiry evaluation', () => {
    it('reports expired status on getApproval when pending approval expiresAt is in the past', async () => {
      const approvalId = randomUUID();
      // Status in DB column is explicitly 'pending', but expires_at is 1 hour in the past!
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'pending', now() - interval '1 hour', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe('expired');
    });

    it('rejects decision with 409 Conflict when pending approval expiresAt is in the past', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', 'hash-1', '{"symbol": "AAPL"}'::jsonb, 'pending', now() - interval '1 hour', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-1' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('Role gating', () => {
    it('permits getApproval for owner, administrator, editor, and viewer', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-role', '{"all": true}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      for (const token of [
        'owner-token',
        'admin-token',
        'editor-token',
        'viewer-token',
      ]) {
        const res = await application.inject({
          method: 'GET',
          url: `/v1/approvals/${approvalId}`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-workspace-id': workspace1Id,
          },
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('forbids getApproval for non-member with 403 Forbidden', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-role', '{"all": true}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer non-member-token',
          'x-workspace-id': workspace1Id,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('permits confirmApproval and rejectApproval for owner and administrator', async () => {
      // Test owner confirm
      const approvalId1 = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-o', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId1, workspace1Id, ownerId],
      );
      const resOwner = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId1}/confirm`,
        headers: {
          authorization: 'Bearer owner-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-o' },
      });
      expect(resOwner.statusCode).toBe(200);

      // Test admin reject
      const approvalId2 = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-a', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId2, workspace1Id, ownerId],
      );
      const resAdmin = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId2}/reject`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-a' },
      });
      expect(resAdmin.statusCode).toBe(200);
    });

    it('forbids confirmApproval and rejectApproval for editor with 403 Forbidden', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-e', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const confirmRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-e' },
      });
      expect(confirmRes.statusCode).toBe(403);

      const rejectRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer editor-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-e' },
      });
      expect(rejectRes.statusCode).toBe(403);
    });

    it('forbids confirmApproval and rejectApproval for viewer with 403 Forbidden', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', 'hash-v', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const confirmRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-v' },
      });
      expect(confirmRes.statusCode).toBe(403);

      const rejectRes = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer viewer-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-v' },
      });
      expect(rejectRes.statusCode).toBe(403);
    });
  });

  describe('Reason code-point validation', () => {
    it('accepts decision with exactly 500 astral emoji characters in reason', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-emoji';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const emoji500 = '🎉'.repeat(500);
      expect([...emoji500].length).toBe(500);

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: emoji500,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects decision with 501 astral emoji characters in reason with 422 Unprocessable', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-emoji';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'export_audit', 'low_risk_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const emoji501 = '🎉'.repeat(501);
      expect([...emoji501].length).toBe(501);

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: emoji501,
        },
      });

      expect(res.statusCode).toBe(422);
    });
  });

  describe('Workspace scoping with dual-workspace member', () => {
    it('returns 404 for getApproval across workspace boundaries with dual member', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_ws1', 'administrative', 'hash-cross', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      // Dual member tries to access approval in workspace 1 using workspace 2 header
      const res = await application.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for confirmApproval across workspace boundaries with dual member', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_ws1', 'administrative', 'hash-cross', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-cross' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for rejectApproval across workspace boundaries with dual member', async () => {
      const approvalId = randomUUID();
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_ws1', 'administrative', 'hash-cross', '{}'::jsonb, 'pending', now() + interval '1 day', $3
        )`,
        [approvalId, workspace1Id, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer dual-member-token',
          'x-workspace-id': workspace2Id,
          'idempotency-key': randomUUID(),
        },
        payload: { argumentsHash: 'hash-cross' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Decision persistence', () => {
    it('persists approved status, decided_by, decided_at, and reason on confirm', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-persist-confirm';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'destructive_tool', 'destructive', $3, '{"table": "logs"}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: 'Authorized by admin',
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify row state directly in database
      const dbRow = await admin.query<{
        status: string;
        decided_by: string;
        decided_at: Date;
        decision_reason: string;
      }>(
        `select status, decided_by, decided_at, decision_reason from public.approvals where id = $1`,
        [approvalId],
      );

      expect(dbRow.rows[0]?.status).toBe('approved');
      expect(dbRow.rows[0]?.decided_by).toBe(adminId);
      expect(dbRow.rows[0]?.decided_at).toBeDefined();
      expect(dbRow.rows[0]?.decision_reason).toBe('Authorized by admin');
    });

    it('persists rejected status, decided_by, decided_at, and reason on reject', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-persist-reject';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'destructive_tool', 'destructive', $3, '{"table": "logs"}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/reject`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': randomUUID(),
        },
        payload: {
          argumentsHash: hash,
          reason: 'Rejected by admin',
        },
      });

      expect(res.statusCode).toBe(200);

      const dbRow = await admin.query<{
        status: string;
        decided_by: string;
        decided_at: Date;
        decision_reason: string;
      }>(
        `select status, decided_by, decided_at, decision_reason from public.approvals where id = $1`,
        [approvalId],
      );

      expect(dbRow.rows[0]?.status).toBe('rejected');
      expect(dbRow.rows[0]?.decided_by).toBe(adminId);
      expect(dbRow.rows[0]?.decided_at).toBeDefined();
      expect(dbRow.rows[0]?.decision_reason).toBe('Rejected by admin');
    });
  });

  describe('Idempotency handling', () => {
    it('replays identical response for repeated confirm with same idempotency key', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);

      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First try' },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2).toEqual(body1);
    });

    it('rejects repeated confirm with different payload using same idempotency key with 409 Conflict', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-idem-diff';
      const idemKey = randomUUID();

      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'tool_idem', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      const res1 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'First reason' },
      });
      expect(res1.statusCode).toBe(200);

      const res2 = await application.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/confirm`,
        headers: {
          authorization: 'Bearer admin-token',
          'x-workspace-id': workspace1Id,
          'idempotency-key': idemKey,
        },
        payload: { argumentsHash: hash, reason: 'Different reason' },
      });
      expect(res2.statusCode).toBe(409);
    });
  });

  describe('Concurrent decision race condition', () => {
    it('serialises concurrent decisions so exactly one succeeds and one receives 409 Conflict', async () => {
      const approvalId = randomUUID();
      const hash = 'hash-concurrent';
      await admin.query(
        `insert into public.approvals (
          id, workspace_id, tool_name, risk_class, arguments_hash, preview, status, expires_at, created_by
        ) values (
          $1, $2, 'execute_trade', 'financial_write', $3, '{}'::jsonb, 'pending', now() + interval '1 day', $4
        )`,
        [approvalId, workspace1Id, hash, ownerId],
      );

      // Install temporary BEFORE UPDATE trigger to make the race deterministic
      await admin.query(`
        create or replace function public.test_delay_approval_update() returns trigger as $$
        begin
          perform pg_sleep(0.3);
          return new;
        end;
        $$ language plpgsql;

        drop trigger if exists trg_test_delay_approval_update on public.approvals;
        create trigger trg_test_delay_approval_update
        before update on public.approvals
        for each row execute function public.test_delay_approval_update();
      `);

      try {
        const [confirmRes, rejectRes] = await Promise.all([
          application.inject({
            method: 'POST',
            url: `/v1/approvals/${approvalId}/confirm`,
            headers: {
              authorization: 'Bearer owner-token',
              'x-workspace-id': workspace1Id,
              'idempotency-key': randomUUID(),
            },
            payload: { argumentsHash: hash, reason: 'Owner confirmation' },
          }),
          application.inject({
            method: 'POST',
            url: `/v1/approvals/${approvalId}/reject`,
            headers: {
              authorization: 'Bearer admin-token',
              'x-workspace-id': workspace1Id,
              'idempotency-key': randomUUID(),
            },
            payload: { argumentsHash: hash, reason: 'Admin rejection' },
          }),
        ]);

        const statusCodes = [confirmRes.statusCode, rejectRes.statusCode].sort(
          (a, b) => a - b,
        );
        expect(statusCodes).toEqual([200, 409]);

        const rowResult = await admin.query<{ status: string }>(
          `select status from public.approvals where id = $1`,
          [approvalId],
        );
        expect(['approved', 'rejected']).toContain(rowResult.rows[0]?.status);
      } finally {
        await admin.query(`
          drop trigger if exists trg_test_delay_approval_update on public.approvals;
          drop function if exists public.test_delay_approval_update();
        `);
      }
    });
  });
});
