// Migrations under test: 202607150010_command_idempotency.sql, 202607150014_workspace_invitations.sql
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdentityModule } from '../../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../../src/identity/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { PostgresWorkspaceInvitationAdapter } from '../../src/identity/postgres-workspace-invitation.adapter.js';
import { PROBLEM_TYPES } from '../../src/identity/problem-details.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('revokeWorkspaceInvitation integration (POST /v1/workspaces/{workspaceId}/invitations/{invitationId}/revoke)', () => {
  let admin: Pool;
  let app: NestFastifyApplication;

  // Subjects
  const ownerSubject = subject(7001);
  const adminSubject = subject(7002);
  const editorSubject = subject(7003);
  const viewerSubject = subject(7004);
  const suspendedSubject = subject(7005);
  const strangerSubject = subject(7006);
  const coOwnerSubject = subject(7007);
  const invitedUserSubject = subject(7008);

  // Workspaces
  const wsMainId = '00000000-0000-0000-0000-000000007100';
  const wsOtherId = '00000000-0000-0000-0000-000000007101';

  // Memberships
  const memOwnerId = '00000000-0000-0000-0000-000000007201';
  const memAdminId = '00000000-0000-0000-0000-000000007202';
  const memEditorId = '00000000-0000-0000-0000-000000007203';
  const memViewerId = '00000000-0000-0000-0000-000000007204';
  const memSuspendedId = '00000000-0000-0000-0000-000000007205';
  const memCoOwnerId = '00000000-0000-0000-0000-000000007206';

  // Invitations
  const invPendingId = '00000000-0000-0000-0000-000000007301';
  const invAdminPendingId = '00000000-0000-0000-0000-000000007302';
  const invExpiredPendingId = '00000000-0000-0000-0000-000000007303';
  const invAcceptedId = '00000000-0000-0000-0000-000000007304';
  const invRevokedId = '00000000-0000-0000-0000-000000007305';
  const invOtherWsId = '00000000-0000-0000-0000-000000007306';
  const invConcurId = '00000000-0000-0000-0000-000000007307';
  const invReplayId = '00000000-0000-0000-0000-000000007308';
  const invConflictId = '00000000-0000-0000-0000-000000007309';
  const invDiffPayloadId = '00000000-0000-0000-0000-000000007310';

  const verifier = {
    verify: (token: string) => {
      if (token.startsWith('bearer-')) {
        const sub = token.replace('bearer-', '');
        return Promise.resolve({ subject: sub });
      }
      return Promise.reject(new Error('unauthorized'));
    },
  };

  function revokeInvitation(
    workspaceId: string,
    invitationId: string,
    caller: string,
    options: { idempotencyKey?: string } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer bearer-${caller}`,
    };
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    return app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invitations/${invitationId}/revoke`,
      headers,
    });
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ISSUER: 'https://issuer.example.test',
      JWT_AUDIENCE: 'savia-api',
      JWT_JWKS_URI: 'https://issuer.example.test/jwks',
      JWT_ALGORITHMS: 'RS256',
    });

    admin = new Pool({ connectionString: url });

    const seedUsers = [
      [ownerSubject, 'owner7@example.test', 'Owner 7'],
      [adminSubject, 'admin7@example.test', 'Admin 7'],
      [editorSubject, 'editor7@example.test', 'Editor 7'],
      [viewerSubject, 'viewer7@example.test', 'Viewer 7'],
      [suspendedSubject, 'suspended7@example.test', 'Suspended 7'],
      [strangerSubject, 'stranger7@example.test', 'Stranger 7'],
      [coOwnerSubject, 'coowner7@example.test', 'CoOwner 7'],
      [invitedUserSubject, 'invited7@example.test', 'Invited 7'],
    ];

    for (const [id, email] of seedUsers) {
      await admin.query(
        `insert into auth.users (id, email) values ($1, $2)
         on conflict (id) do nothing`,
        [id, email],
      );
    }

    for (const [id, email, name] of seedUsers) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)
         on conflict (id) do update set email = excluded.email, display_name = excluded.display_name`,
        [id, email, name],
      );
    }

    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Main Shared Workspace', 'shared', 'USD', null, $2),
              ($3, 'Other Shared Workspace', 'shared', 'USD', null, $2)
       on conflict (id) do nothing`,
      [wsMainId, ownerSubject, wsOtherId],
    );

    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'administrator', 'active'),
              ($7, $8, $9, 'editor', 'active'),
              ($10, $11, $12, 'viewer', 'active'),
              ($13, $14, $15, 'viewer', 'suspended'),
              ($16, $17, $18, 'owner', 'active')
       on conflict (id) do nothing`,
      [
        memOwnerId,
        wsMainId,
        ownerSubject,
        memAdminId,
        wsMainId,
        adminSubject,
        memEditorId,
        wsMainId,
        editorSubject,
        memViewerId,
        wsMainId,
        viewerSubject,
        memSuspendedId,
        wsMainId,
        suspendedSubject,
        memCoOwnerId,
        wsMainId,
        coOwnerSubject,
      ],
    );

    // Insert test invitations
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at, created_at)
       values ($1, $2, $3, 'target-pending@example.test', 'editor', 'pending', now() + interval '7 days', now()),
              ($4, $2, $3, 'admin-pending@example.test', 'viewer', 'pending', now() + interval '7 days', now()),
              ($5, $2, $3, 'expired-pending@example.test', 'editor', 'pending', now() - interval '1 day', now() - interval '8 days'),
              ($6, $2, $3, 'accepted@example.test', 'editor', 'accepted', now() + interval '7 days', now()),
              ($7, $2, $3, 'revoked@example.test', 'editor', 'revoked', now() + interval '7 days', now()),
              ($8, $9, $3, 'other-ws@example.test', 'editor', 'pending', now() + interval '7 days', now()),
              ($10, $2, $3, 'concur@example.test', 'editor', 'pending', now() + interval '7 days', now()),
              ($11, $2, $3, 'replay@example.test', 'editor', 'pending', now() + interval '7 days', now()),
              ($12, $2, $3, 'conflict@example.test', 'editor', 'accepted', now() + interval '7 days', now()),
              ($13, $2, $3, 'diff-payload@example.test', 'editor', 'pending', now() + interval '7 days', now())
       on conflict (id) do nothing`,
      [
        invPendingId,
        wsMainId,
        ownerSubject,
        invAdminPendingId,
        invExpiredPendingId,
        invAcceptedId,
        invRevokedId,
        invOtherWsId,
        wsOtherId,
        invConcurId,
        invReplayId,
        invConflictId,
        invDiffPayloadId,
      ],
    );
    await admin.query('commit');

    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue(verifier)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ exposeHeadRoutes: false }),
    );
    registerProblemFilter(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it('row 10: owner can revoke a pending workspace invitation (200)', async () => {
    const key = '00000000-0000-0000-0000-000000008001';
    const response = await revokeInvitation(
      wsMainId,
      invPendingId,
      ownerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(invPendingId);
    expect(body.status).toBe('revoked');
    expect(body.email).toBe('target-pending@example.test');
    expect(body.role).toBe('editor');

    const res = await admin.query(
      'select status from public.workspace_invitations where id = $1',
      [invPendingId],
    );
    expect(res.rows[0]?.status).toBe('revoked');
  });

  it('row 10: administrator can revoke a pending workspace invitation (200)', async () => {
    const key = '00000000-0000-0000-0000-000000008002';
    const response = await revokeInvitation(
      wsMainId,
      invAdminPendingId,
      adminSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(invAdminPendingId);
    expect(body.status).toBe('revoked');

    const res = await admin.query(
      'select status from public.workspace_invitations where id = $1',
      [invAdminPendingId],
    );
    expect(res.rows[0]?.status).toBe('revoked');
  });

  it('row 10 / RULING 28: revoking an expired pending invitation succeeds and reports status revoked (200)', async () => {
    const key = '00000000-0000-0000-0000-000000008003';
    const response = await revokeInvitation(
      wsMainId,
      invExpiredPendingId,
      ownerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(invExpiredPendingId);
    expect(body.status).toBe('revoked');

    const res = await admin.query(
      'select status from public.workspace_invitations where id = $1',
      [invExpiredPendingId],
    );
    expect(res.rows[0]?.status).toBe('revoked');
  });

  it('row 9: revoking an already accepted invitation returns 409 workspace-invitation-not-pending', async () => {
    const key = '00000000-0000-0000-0000-000000008004';
    const response = await revokeInvitation(
      wsMainId,
      invAcceptedId,
      ownerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.WORKSPACE_INVITATION_NOT_PENDING);
    expect(body.code).toBe('workspace-invitation-not-pending');
  });

  it('row 9: revoking an already revoked invitation returns 409 workspace-invitation-not-pending', async () => {
    const key = '00000000-0000-0000-0000-000000008005';
    const response = await revokeInvitation(
      wsMainId,
      invRevokedId,
      ownerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.WORKSPACE_INVITATION_NOT_PENDING);
    expect(body.code).toBe('workspace-invitation-not-pending');
  });

  it('row 8: invitation does not exist in workspace returns 404', async () => {
    const key = '00000000-0000-0000-0000-000000008006';
    const nonExistentId = '00000000-0000-0000-0000-000000009999';
    const response = await revokeInvitation(
      wsMainId,
      nonExistentId,
      ownerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
  });

  it('row 8: invitation belonging to a different workspace returns 404', async () => {
    const key = '00000000-0000-0000-0000-000000008007';
    const response = await revokeInvitation(
      wsMainId,
      invOtherWsId,
      ownerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
  });

  it('row 5: caller has no membership in workspace returns 404', async () => {
    const key = '00000000-0000-0000-0000-000000008008';
    const response = await revokeInvitation(
      wsMainId,
      invPendingId,
      strangerSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
  });

  it('row 6: caller is suspended returns 403', async () => {
    const key = '00000000-0000-0000-0000-000000008009';
    const response = await revokeInvitation(
      wsMainId,
      invPendingId,
      suspendedSubject,
      { idempotencyKey: key },
    );

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
  });

  it('row 7: caller is editor or viewer returns 403', async () => {
    for (const [callerSub, key] of [
      [editorSubject, '00000000-0000-0000-0000-000000008010'],
      [viewerSubject, '00000000-0000-0000-0000-000000008011'],
    ]) {
      const response = await revokeInvitation(
        wsMainId,
        invPendingId,
        callerSub,
        { idempotencyKey: key },
      );

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
    }
  });

  it('idempotency: same key with same payload replays stored 200 response verbatim', async () => {
    const key = '00000000-0000-0000-0000-000000008012';
    const res1 = await revokeInvitation(wsMainId, invReplayId, ownerSubject, {
      idempotencyKey: key,
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await revokeInvitation(wsMainId, invReplayId, ownerSubject, {
      idempotencyKey: key,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual(res1.json());
  });

  it('idempotency: same key with same payload replays stored 409 not-pending with correct problem type', async () => {
    const key = '00000000-0000-0000-0000-000000008013';
    const res1 = await revokeInvitation(wsMainId, invConflictId, ownerSubject, {
      idempotencyKey: key,
    });
    expect(res1.statusCode).toBe(409);
    expect(res1.json().type).toBe(
      PROBLEM_TYPES.WORKSPACE_INVITATION_NOT_PENDING,
    );

    const res2 = await revokeInvitation(wsMainId, invConflictId, ownerSubject, {
      idempotencyKey: key,
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().type).toBe(
      PROBLEM_TYPES.WORKSPACE_INVITATION_NOT_PENDING,
    );
  });

  it('idempotency: same key with different payload returns 409 generic conflict', async () => {
    const key = '00000000-0000-0000-0000-000000008014';
    const res1 = await revokeInvitation(
      wsMainId,
      invDiffPayloadId,
      ownerSubject,
      {
        idempotencyKey: key,
      },
    );
    expect(res1.statusCode).toBe(200);

    const res2 = await revokeInvitation(wsMainId, invReplayId, ownerSubject, {
      idempotencyKey: key,
    });
    expect(res2.statusCode).toBe(409);
    const body = res2.json();
    expect(body.type).toBe(PROBLEM_TYPES.CONFLICT);
    expect(body.code).toBe('conflict');
  });

  it('concurrency: two different subjects revoking the same invitation concurrently results in one 200 and one 409 not-pending', async () => {
    const key1 = '00000000-0000-0000-0000-000000008015';
    const key2 = '00000000-0000-0000-0000-000000008016';

    const [res1, res2] = await Promise.all([
      revokeInvitation(wsMainId, invConcurId, ownerSubject, {
        idempotencyKey: key1,
      }),
      revokeInvitation(wsMainId, invConcurId, coOwnerSubject, {
        idempotencyKey: key2,
      }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const res409 = res1.statusCode === 409 ? res1 : res2;
    expect(res409.json().type).toBe(
      PROBLEM_TYPES.WORKSPACE_INVITATION_NOT_PENDING,
    );
  });

  it('row 9 / adapter: revokePendingInvitation on a non-pending row returns undefined without updating', async () => {
    const adapter = new PostgresWorkspaceInvitationAdapter();
    const result = await adapter.revokePendingInvitation(
      admin,
      wsMainId,
      invAcceptedId,
    );
    expect(result).toBeUndefined();
  });

  it('RULING 19 / adapter: readInvitation projects expired when expires_at is in past on a stored pending row', async () => {
    const adapter = new PostgresWorkspaceInvitationAdapter();
    const result = await adapter.readInvitation(
      admin,
      wsMainId,
      invExpiredPendingId,
    );
    expect(result?.status).toBe('expired');
  });
});
