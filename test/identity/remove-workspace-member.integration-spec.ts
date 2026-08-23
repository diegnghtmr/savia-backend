// Migrations under test: 202607150010_command_idempotency.sql, 202607150011_membership_write_rls.sql, 202607150012_last_owner_guard.sql, 202607150013_workspace_member_roster.sql
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
import { PgTransaction } from '../../src/identity/pg-transaction.js';
import { PostgresConfig } from '../../src/identity/postgres-config.js';
import { PostgresIdempotencyAdapter } from '../../src/identity/postgres-idempotency.adapter.js';
import { PostgresPool } from '../../src/identity/postgres-pool.js';
import { PostgresWorkspaceMemberAdapter } from '../../src/identity/postgres-workspace-member.adapter.js';
import { PROBLEM_TYPES } from '../../src/identity/problem-details.js';
import { WORKSPACE_MEMBER_REMOVE_OUTCOMES } from '../../src/identity/workspace-member.port.js';
import {
  WorkspaceMemberService,
  type WorkspaceMemberStore,
} from '../../src/identity/workspace-member.service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('removeWorkspaceMember integration (DELETE /v1/workspaces/{workspaceId}/members/{memberId})', () => {
  let admin: Pool;
  let app: NestFastifyApplication;

  // Subjects
  const ownerSubject = subject(3001);
  const adminSubject = subject(3002);
  const editorSubject = subject(3003);
  const viewerSubject = subject(3004);
  const suspendedSubject = subject(3005);
  const nonMemberSubject = subject(3006);
  const otherOwnerSubject = subject(3007);
  const personalOwnerSubject = subject(3008);
  const soleOwnerSubject = subject(3009);
  const twoOwner1Subject = subject(3010);
  const twoOwner2Subject = subject(3011);
  const selfTwoOwner1Subject = subject(3012);
  const selfTwoOwner2Subject = subject(3013);
  const selfSoleOwnerSubject = subject(3014);
  const concurTwo1Subject = subject(3015);
  const concurTwo2Subject = subject(3016);
  const concurThree1Subject = subject(3017);
  const concurThree2Subject = subject(3018);
  const concurThree3Subject = subject(3019);
  const bothAdminSubject = subject(3020);
  const otherViewerSubject = subject(3021);
  const secondMainOwnerSubject = subject(3022);
  const adminToRemoveSubject = subject(3023);
  const editorToRemoveSubject = subject(3024);
  const authViewerSubject = subject(3025);

  // Workspaces
  const wsMainId = '00000000-0000-0000-0000-000000003100';
  const wsOtherId = '00000000-0000-0000-0000-000000003101';
  const wsPersonalId = '00000000-0000-0000-0000-000000003102';
  const wsSoleOwnerId = '00000000-0000-0000-0000-000000003103';
  const wsTwoOwnersId = '00000000-0000-0000-0000-000000003104';
  const wsSelfTwoOwnersId = '00000000-0000-0000-0000-000000003105';
  const wsSelfSoleOwnerId = '00000000-0000-0000-0000-000000003106';
  const wsConcurTwoId = '00000000-0000-0000-0000-000000003107';
  const wsConcurThreeId = '00000000-0000-0000-0000-000000003108';

  // Memberships
  const memOwnerId = '00000000-0000-0000-0000-000000003201';
  const memAdminId = '00000000-0000-0000-0000-000000003202';
  const memEditorId = '00000000-0000-0000-0000-000000003203';
  const memViewerId = '00000000-0000-0000-0000-000000003204';
  const memSuspendedId = '00000000-0000-0000-0000-000000003205';
  const memBothAdminMainId = '00000000-0000-0000-0000-000000003206';
  const memSecondMainOwnerId = '00000000-0000-0000-0000-000000003207';
  const memAdminToRemoveId = '00000000-0000-0000-0000-000000003208';
  const memEditorToRemoveId = '00000000-0000-0000-0000-000000003209';
  const memAuthViewerId = '00000000-0000-0000-0000-000000003225';

  const memOtherOwnerId = '00000000-0000-0000-0000-000000003210';
  const memBothAdminOtherId = '00000000-0000-0000-0000-000000003211';
  const memOtherViewerId = '00000000-0000-0000-0000-000000003212';

  const memPersonalId = '00000000-0000-0000-0000-000000003220';
  const memSoleOwnerId = '00000000-0000-0000-0000-000000003230';
  const memTwoOwner1Id = '00000000-0000-0000-0000-000000003241';
  const memTwoOwner2Id = '00000000-0000-0000-0000-000000003242';
  const memSelfTwoOwner1Id = '00000000-0000-0000-0000-000000003251';
  const memSelfTwoOwner2Id = '00000000-0000-0000-0000-000000003252';
  const memSelfSoleOwnerId = '00000000-0000-0000-0000-000000003260';
  const memConcurTwo1Id = '00000000-0000-0000-0000-000000003271';
  const memConcurTwo2Id = '00000000-0000-0000-0000-000000003272';
  const memConcurThree1Id = '00000000-0000-0000-0000-000000003281';
  const memConcurThree2Id = '00000000-0000-0000-0000-000000003282';
  const memConcurThree3Id = '00000000-0000-0000-0000-000000003283';

  const verifier = {
    verify: (token: string) => {
      if (token.startsWith('bearer-')) {
        const sub = token.replace('bearer-', '');
        return Promise.resolve({ subject: sub });
      }
      return Promise.reject(new Error('unauthorized'));
    },
  };

  function deleteMember(
    workspaceId: string,
    memberId: string,
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
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/members/${memberId}`,
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
      [ownerSubject, 'owner3@example.test', 'Owner User 3'],
      [adminSubject, 'admin3@example.test', 'Admin User 3'],
      [editorSubject, 'editor3@example.test', 'Editor User 3'],
      [viewerSubject, 'viewer3@example.test', 'Viewer User 3'],
      [suspendedSubject, 'suspended3@example.test', 'Suspended User 3'],
      [nonMemberSubject, 'nonmember3@example.test', 'NonMember User 3'],
      [otherOwnerSubject, 'otherowner3@example.test', 'OtherOwner User 3'],
      [personalOwnerSubject, 'personal3@example.test', 'Personal User 3'],
      [soleOwnerSubject, 'sole3@example.test', 'Sole User 3'],
      [twoOwner1Subject, 'two1_3@example.test', 'Two Owner 1_3'],
      [twoOwner2Subject, 'two2_3@example.test', 'Two Owner 2_3'],
      [selfTwoOwner1Subject, 'selftwo1_3@example.test', 'Self Two 1_3'],
      [selfTwoOwner2Subject, 'selftwo2_3@example.test', 'Self Two 2_3'],
      [selfSoleOwnerSubject, 'selfsole3@example.test', 'Self Sole 3'],
      [concurTwo1Subject, 'concurtwo1_3@example.test', 'Concur Two 1_3'],
      [concurTwo2Subject, 'concurtwo2_3@example.test', 'Concur Two 2_3'],
      [concurThree1Subject, 'concurthree1_3@example.test', 'Concur Three 1_3'],
      [concurThree2Subject, 'concurthree2_3@example.test', 'Concur Three 2_3'],
      [concurThree3Subject, 'concurthree3_3@example.test', 'Concur Three 3_3'],
      [bothAdminSubject, 'bothadmin3@example.test', 'Both Admin User 3'],
      [otherViewerSubject, 'otherviewer3@example.test', 'Other Viewer User 3'],
      [
        secondMainOwnerSubject,
        'secondmainowner3@example.test',
        'Second Main Owner 3',
      ],
      [
        adminToRemoveSubject,
        'admintoremove3@example.test',
        'Admin To Remove 3',
      ],
      [
        editorToRemoveSubject,
        'editortoremove3@example.test',
        'Editor To Remove 3',
      ],
      [authViewerSubject, 'authviewer3@example.test', 'Auth Viewer User 3'],
    ] as const;

    for (const [id, email, name] of seedUsers) {
      await admin.query('insert into auth.users (id, email) values ($1, $2)', [
        id,
        email,
      ]);
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    // Seed Workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Main Workspace 3', 'shared', 'USD', null, $2),
              ($3, 'Other Workspace 3', 'shared', 'USD', null, $4),
              ($5, 'Sole Owner Workspace 3', 'family', 'USD', null, $6),
              ($7, 'Two Owners Workspace 3', 'shared', 'USD', null, $8),
              ($9, 'Self Two Owners Workspace 3', 'shared', 'USD', null, $10),
              ($11, 'Self Sole Workspace 3', 'family', 'USD', null, $12),
              ($13, 'Concurrent Two Workspace 3', 'shared', 'USD', null, $14),
              ($15, 'Concurrent Three Workspace 3', 'shared', 'USD', null, $16)`,
      [
        wsMainId,
        ownerSubject,
        wsOtherId,
        otherOwnerSubject,
        wsSoleOwnerId,
        soleOwnerSubject,
        wsTwoOwnersId,
        twoOwner1Subject,
        wsSelfTwoOwnersId,
        selfTwoOwner1Subject,
        wsSelfSoleOwnerId,
        selfSoleOwnerSubject,
        wsConcurTwoId,
        concurTwo1Subject,
        wsConcurThreeId,
        concurThree1Subject,
      ],
    );

    // Personal workspace
    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Personal Workspace 3', 'personal', 'USD', $2, $2)`,
      [wsPersonalId, personalOwnerSubject],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status, joined_at, version)
       values ($1, $2, $3, 'owner', 'active', '2026-07-15T00:00:00.000Z', 1)`,
      [memPersonalId, wsPersonalId, personalOwnerSubject],
    );
    await admin.query('commit');

    // Memberships for other workspaces
    const seedMemberships: [
      string,
      string,
      string,
      string,
      string,
      string,
      number,
    ][] = [
      [
        memOwnerId,
        wsMainId,
        ownerSubject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],
      [
        memSecondMainOwnerId,
        wsMainId,
        secondMainOwnerSubject,
        'owner',
        'active',
        '2026-07-15T01:30:00.000Z',
        1,
      ],
      [
        memAdminId,
        wsMainId,
        adminSubject,
        'administrator',
        'active',
        '2026-07-15T02:00:00.000Z',
        1,
      ],
      [
        memAdminToRemoveId,
        wsMainId,
        adminToRemoveSubject,
        'administrator',
        'active',
        '2026-07-15T02:30:00.000Z',
        1,
      ],
      [
        memEditorId,
        wsMainId,
        editorSubject,
        'editor',
        'active',
        '2026-07-15T03:00:00.000Z',
        1,
      ],
      [
        memEditorToRemoveId,
        wsMainId,
        editorToRemoveSubject,
        'editor',
        'active',
        '2026-07-15T03:30:00.000Z',
        1,
      ],
      [
        memViewerId,
        wsMainId,
        viewerSubject,
        'viewer',
        'active',
        '2026-07-15T04:00:00.000Z',
        1,
      ],
      [
        memAuthViewerId,
        wsMainId,
        authViewerSubject,
        'viewer',
        'active',
        '2026-07-15T04:30:00.000Z',
        1,
      ],
      [
        memSuspendedId,
        wsMainId,
        suspendedSubject,
        'editor',
        'suspended',
        '2026-07-15T05:00:00.000Z',
        1,
      ],
      [
        memBothAdminMainId,
        wsMainId,
        bothAdminSubject,
        'administrator',
        'active',
        '2026-07-15T06:00:00.000Z',
        1,
      ],

      // Other workspace
      [
        memOtherOwnerId,
        wsOtherId,
        otherOwnerSubject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],
      [
        memBothAdminOtherId,
        wsOtherId,
        bothAdminSubject,
        'administrator',
        'active',
        '2026-07-15T02:00:00.000Z',
        1,
      ],
      [
        memOtherViewerId,
        wsOtherId,
        otherViewerSubject,
        'viewer',
        'active',
        '2026-07-15T03:00:00.000Z',
        1,
      ],

      // Sole owner workspace
      [
        memSoleOwnerId,
        wsSoleOwnerId,
        soleOwnerSubject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],

      // Two owners workspace
      [
        memTwoOwner1Id,
        wsTwoOwnersId,
        twoOwner1Subject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],
      [
        memTwoOwner2Id,
        wsTwoOwnersId,
        twoOwner2Subject,
        'owner',
        'active',
        '2026-07-15T02:00:00.000Z',
        1,
      ],

      // Self two owners workspace
      [
        memSelfTwoOwner1Id,
        wsSelfTwoOwnersId,
        selfTwoOwner1Subject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],
      [
        memSelfTwoOwner2Id,
        wsSelfTwoOwnersId,
        selfTwoOwner2Subject,
        'owner',
        'active',
        '2026-07-15T02:00:00.000Z',
        1,
      ],

      // Self sole owner workspace
      [
        memSelfSoleOwnerId,
        wsSelfSoleOwnerId,
        selfSoleOwnerSubject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],

      // Concurrent two workspace
      [
        memConcurTwo1Id,
        wsConcurTwoId,
        concurTwo1Subject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],
      [
        memConcurTwo2Id,
        wsConcurTwoId,
        concurTwo2Subject,
        'owner',
        'active',
        '2026-07-15T02:00:00.000Z',
        1,
      ],

      // Concurrent three workspace
      [
        memConcurThree1Id,
        wsConcurThreeId,
        concurThree1Subject,
        'owner',
        'active',
        '2026-07-15T01:00:00.000Z',
        1,
      ],
      [
        memConcurThree2Id,
        wsConcurThreeId,
        concurThree2Subject,
        'owner',
        'active',
        '2026-07-15T02:00:00.000Z',
        1,
      ],
      [
        memConcurThree3Id,
        wsConcurThreeId,
        concurThree3Subject,
        'viewer',
        'active',
        '2026-07-15T03:00:00.000Z',
        1,
      ],
    ];

    for (const [
      id,
      wsId,
      pId,
      role,
      status,
      joinedAt,
      ver,
    ] of seedMemberships) {
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status, joined_at, version)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, wsId, pId, role, status, joinedAt, ver],
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    })
      .overrideProvider(PostgresConfig)
      .useValue({ url })
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

  describe('Happy Paths & Member Deletion Verification', () => {
    it('owner removes viewer: returns 204 and deletes membership row from table and roster', async () => {
      const key = 'a0000000-0000-0000-0000-000000000001';
      const res = await deleteMember(wsMainId, memViewerId, ownerSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      // Verify row is gone from workspace_memberships
      const tableCheck = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memViewerId],
      );
      expect(tableCheck.rows).toHaveLength(0);

      // Verify row is absent from workspace_member_roster
      const rosterCheck = await admin.query(
        'select * from public.workspace_member_roster($1) where membership_id = $2::uuid',
        [wsMainId, memViewerId],
      );
      expect(rosterCheck.rows).toHaveLength(0);
    });

    it('administrator removes editor: returns 204', async () => {
      const key = 'a0000000-0000-0000-0000-000000000002';
      const res = await deleteMember(
        wsMainId,
        memEditorToRemoveId,
        adminSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memEditorToRemoveId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('owner removes administrator: returns 204', async () => {
      const key = 'a0000000-0000-0000-0000-000000000003';
      const res = await deleteMember(
        wsMainId,
        memAdminToRemoveId,
        ownerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memAdminToRemoveId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('owner removes co-owner when another owner remains: returns 204', async () => {
      const key = 'a0000000-0000-0000-0000-000000000004';
      const res = await deleteMember(
        wsTwoOwnersId,
        memTwoOwner2Id,
        twoOwner1Subject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memTwoOwner2Id],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('happy path: an owner removes their own membership when another owner remains: returns 204 and caller loses access', async () => {
      const key = 'a0000000-0000-0000-0000-000000000005';
      const res = await deleteMember(
        wsSelfTwoOwnersId,
        memSelfTwoOwner1Id,
        selfTwoOwner1Subject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      // Verify row is gone from workspace_memberships
      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memSelfTwoOwner1Id],
      );
      expect(check.rows).toHaveLength(0);

      // Verify caller can no longer read the workspace
      const readRes = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${wsSelfTwoOwnersId}`,
        headers: {
          authorization: `Bearer bearer-${selfTwoOwner1Subject}`,
        },
      });
      expect(readRes.statusCode).toBe(404);
    });
  });

  describe('Idempotency Replay & Conflict Handling', () => {
    it('replays 204 with empty body when called with the same key and same parameters', async () => {
      const key = 'a0000000-0000-0000-0000-000000000001';
      const replayRes = await deleteMember(
        wsMainId,
        memViewerId,
        ownerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(replayRes.statusCode).toBe(204);
      expect(replayRes.body).toBe('');
    });

    it('replays 409 personal-workspace-membership with exact problem details', async () => {
      const key = 'a0000000-0000-0000-0000-000000000010';
      const first = await deleteMember(
        wsPersonalId,
        memPersonalId,
        personalOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(first.statusCode).toBe(409);
      expect(first.json().type).toBe(
        PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
      );
      expect(first.json().code).toBe('personal-workspace-membership');

      const replay = await deleteMember(
        wsPersonalId,
        memPersonalId,
        personalOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(replay.statusCode).toBe(409);
      expect(replay.json().type).toBe(
        PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
      );
      expect(replay.json().code).toBe('personal-workspace-membership');
      expect(replay.json().status).toBe(409);
    });

    it('replays 409 last-owner-required with exact problem details', async () => {
      const key = 'a0000000-0000-0000-0000-000000000011';
      const first = await deleteMember(
        wsSoleOwnerId,
        memSoleOwnerId,
        soleOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(first.statusCode).toBe(409);
      expect(first.json().type).toBe(PROBLEM_TYPES.LAST_OWNER_REQUIRED);
      expect(first.json().code).toBe('last-owner-required');

      const replay = await deleteMember(
        wsSoleOwnerId,
        memSoleOwnerId,
        soleOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(replay.statusCode).toBe(409);
      expect(replay.json().type).toBe(PROBLEM_TYPES.LAST_OWNER_REQUIRED);
      expect(replay.json().code).toBe('last-owner-required');
    });

    it('replays 403 forbidden refusal', async () => {
      const key = 'a0000000-0000-0000-0000-000000000012';
      const first = await deleteMember(wsMainId, memOwnerId, adminSubject, {
        idempotencyKey: key,
      });
      expect(first.statusCode).toBe(403);
      expect(first.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(first.json().code).toBe('forbidden');

      const replay = await deleteMember(wsMainId, memOwnerId, adminSubject, {
        idempotencyKey: key,
      });
      expect(replay.statusCode).toBe(403);
      expect(replay.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(replay.json().code).toBe('forbidden');
    });

    it('replays 404 not-found refusal', async () => {
      const key = 'a0000000-0000-0000-0000-000000000013';
      const nonExistentMember = '00000000-0000-0000-0000-999999999999';
      const first = await deleteMember(
        wsMainId,
        nonExistentMember,
        ownerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(first.statusCode).toBe(404);
      expect(first.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(first.json().code).toBe('not-found');

      const replay = await deleteMember(
        wsMainId,
        nonExistentMember,
        ownerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(replay.statusCode).toBe(404);
      expect(replay.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(replay.json().code).toBe('not-found');
    });

    it('returns 409 conflict when idempotency key is reused with a different memberId', async () => {
      const key = 'a0000000-0000-0000-0000-000000000001'; // Used for memViewerId earlier
      const conflictRes = await deleteMember(
        wsMainId,
        memEditorId,
        ownerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(conflictRes.statusCode).toBe(409);
      expect(conflictRes.json().type).toBe(PROBLEM_TYPES.CONFLICT);
      expect(conflictRes.json().code).toBe('conflict');
    });
  });

  describe('Authorization & Visibility Rules', () => {
    it('pins RLS visibility: returns 404 not-found when caller is a non-member of the workspace', async () => {
      // Note: Step 5 in WorkspaceMemberService is defence in depth; even if omitted, non-member read visibility under RLS produces 404.
      const key = 'a0000000-0000-0000-0000-000000000020';
      const res = await deleteMember(wsMainId, memEditorId, nonMemberSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(res.json().code).toBe('not-found');
    });

    it('returns 403 forbidden when caller membership is suspended', async () => {
      const key = 'a0000000-0000-0000-0000-000000000021';
      const res = await deleteMember(wsMainId, memEditorId, suspendedSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(res.json().code).toBe('forbidden');
    });

    it('returns 403 forbidden when caller role is editor', async () => {
      const key = 'a0000000-0000-0000-0000-000000000022';
      const res = await deleteMember(wsMainId, memAdminId, editorSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(res.json().code).toBe('forbidden');
    });

    it('returns 403 forbidden when caller role is viewer', async () => {
      const key = 'a0000000-0000-0000-0000-000000000023';
      const res = await deleteMember(wsMainId, memEditorId, authViewerSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(res.json().code).toBe('forbidden');
    });

    it('returns 403 forbidden when administrator attempts to remove an owner (RULING 7)', async () => {
      // Note: Step 10 in WorkspaceMemberService is defence in depth; removing it still yields 403 through RLS (application_deletes_administered_membership) plus the residual check.
      const key = 'a0000000-0000-0000-0000-000000000024';
      const res = await deleteMember(wsMainId, memOwnerId, adminSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(res.json().code).toBe('forbidden');

      // Verify owner row was not deleted
      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memOwnerId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('documented limitation: an active editor cannot remove their own membership because RLS DELETE requires an administrator role (403 forbidden)', async () => {
      const key = 'a0000000-0000-0000-0000-000000000025';
      const res = await deleteMember(wsMainId, memEditorId, editorSubject, {
        idempotencyKey: key,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(res.json().code).toBe('forbidden');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memEditorId],
      );
      expect(check.rows).toHaveLength(1);
      expect(check.rows[0].role).toBe('editor');
    });

    it('documented limitation: an active viewer cannot remove their own membership because RLS DELETE requires an administrator role (403 forbidden)', async () => {
      const key = 'a0000000-0000-0000-0000-000000000026';
      const res = await deleteMember(
        wsMainId,
        memAuthViewerId,
        authViewerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(res.json().code).toBe('forbidden');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memAuthViewerId],
      );
      expect(check.rows).toHaveLength(1);
      expect(check.rows[0].role).toBe('viewer');
    });
  });

  describe('Dual-Admin Cross-Workspace Targeting Fixture', () => {
    it('returns 404 not-found and preserves target row when caller targets a member from another workspace', async () => {
      const key = 'a0000000-0000-0000-0000-000000000030';
      // bothAdminSubject is administrator in wsMainId and administrator in wsOtherId.
      // memOtherViewerId is a membership in wsOtherId.
      // Request targets wsMainId with memOtherViewerId.
      const res = await deleteMember(
        wsMainId,
        memOtherViewerId,
        bothAdminSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(res.json().code).toBe('not-found');

      // Crucial: verify memOtherViewerId in wsOtherId is completely unharmed!
      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1 and workspace_id = $2',
        [memOtherViewerId, wsOtherId],
      );
      expect(check.rows).toHaveLength(1);
      expect(check.rows[0].role).toBe('viewer');
    });
  });

  describe('Refusals & Invariants', () => {
    it('returns 409 personal-workspace-membership when removing member from personal workspace (RULING 5)', async () => {
      const key = 'a0000000-0000-0000-0000-000000000040';
      const res = await deleteMember(
        wsPersonalId,
        memPersonalId,
        personalOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().type).toBe(PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP);
      expect(res.json().code).toBe('personal-workspace-membership');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memPersonalId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('returns 409 last-owner-required when removing the sole active owner', async () => {
      const key = 'a0000000-0000-0000-0000-000000000041';
      const res = await deleteMember(
        wsSoleOwnerId,
        memSoleOwnerId,
        soleOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().type).toBe(PROBLEM_TYPES.LAST_OWNER_REQUIRED);
      expect(res.json().code).toBe('last-owner-required');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memSoleOwnerId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('returns 409 last-owner-required when sole owner tries to remove themselves', async () => {
      const key = 'a0000000-0000-0000-0000-000000000042';
      const res = await deleteMember(
        wsSelfSoleOwnerId,
        memSelfSoleOwnerId,
        selfSoleOwnerSubject,
        {
          idempotencyKey: key,
        },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().type).toBe(PROBLEM_TYPES.LAST_OWNER_REQUIRED);
      expect(res.json().code).toBe('last-owner-required');

      const check = await admin.query(
        'select * from public.workspace_memberships where id = $1',
        [memSelfSoleOwnerId],
      );
      expect(check.rows).toHaveLength(1);
    });
  });

  describe('Concurrency & Race Conditions', () => {
    it('concurrent deletion of two co-owners never empties the workspace: exactly one succeeds and the other is refused (409 last-owner-required, or 404 when it began after the winner committed)', async () => {
      // The fixture makes each co-owner delete the OTHER owner's membership, so the winner deletes the loser's own row.
      // - If the winner commits before the loser reads its caller membership at step 5 (WorkspaceMemberService),
      //   the loser is already a non-member and correctly receives 404 not-found under the Visibility Rule.
      // - If the transactions overlap such that the loser passes step 5 and reaches step 11 (WorkspaceMemberService),
      //   retainsActiveOwner returns false and the loser correctly receives 409 last-owner-required.
      // Both loser outcomes are honest; the invariant is that exactly one removal succeeds (204) and exactly one owner remains.
      const key1 = 'a0000000-0000-0000-0000-000000000051';
      const key2 = 'a0000000-0000-0000-0000-000000000052';

      const [res1, res2] = await Promise.all([
        deleteMember(wsConcurTwoId, memConcurTwo1Id, concurTwo2Subject, {
          idempotencyKey: key1,
        }),
        deleteMember(wsConcurTwoId, memConcurTwo2Id, concurTwo1Subject, {
          idempotencyKey: key2,
        }),
      ]);

      const successCount = [res1, res2].filter(
        (r) => r.statusCode === 204,
      ).length;
      expect(successCount).toBe(1);

      const failedRes = res1.statusCode === 204 ? res2 : res1;
      expect([404, 409]).toContain(failedRes.statusCode);

      if (failedRes.statusCode === 409) {
        expect(failedRes.json().type).toBe(PROBLEM_TYPES.LAST_OWNER_REQUIRED);
        expect(failedRes.json().code).toBe('last-owner-required');
      } else {
        expect(failedRes.json().type).toBe(PROBLEM_TYPES.NOT_FOUND);
        expect(failedRes.json().code).toBe('not-found');
      }

      // Verify that exactly one owner remains
      const remaining = await admin.query(
        'select * from public.workspace_memberships where workspace_id = $1 and role = $2',
        [wsConcurTwoId, 'owner'],
      );
      expect(remaining.rows).toHaveLength(1);
    });

    it('concurrent deletion of the same member: exactly one succeeds (204) and one returns 404', async () => {
      const key1 = 'a0000000-0000-0000-0000-000000000061';
      const key2 = 'a0000000-0000-0000-0000-000000000062';

      const [res1, res2] = await Promise.all([
        deleteMember(wsConcurThreeId, memConcurThree3Id, concurThree1Subject, {
          idempotencyKey: key1,
        }),
        deleteMember(wsConcurThreeId, memConcurThree3Id, concurThree2Subject, {
          idempotencyKey: key2,
        }),
      ]);

      const statuses = [res1.statusCode, res2.statusCode].sort();
      expect(statuses).toEqual([204, 404]);
    });
  });

  describe('Hostile Inputs & Bad Requests', () => {
    it('returns 400 bad-request when Idempotency-Key header is missing', async () => {
      const res = await deleteMember(wsMainId, memEditorId, ownerSubject);
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request when Idempotency-Key is not a valid UUID', async () => {
      const res = await deleteMember(wsMainId, memEditorId, ownerSubject, {
        idempotencyKey: 'not-a-valid-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request when Idempotency-Key contains a NUL byte', async () => {
      const res = await deleteMember(wsMainId, memEditorId, ownerSubject, {
        idempotencyKey: 'a0000000-0000-0000-0000-000000000001\0extra',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request when Idempotency-Key exceeds 255 characters', async () => {
      const res = await deleteMember(wsMainId, memEditorId, ownerSubject, {
        idempotencyKey: 'a'.repeat(256),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request when workspaceId is not a UUID', async () => {
      const res = await deleteMember('not-a-uuid', memEditorId, ownerSubject, {
        idempotencyKey: 'a0000000-0000-0000-0000-000000000070',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request and never 500 when workspaceId contains a NUL byte', async () => {
      const res = await deleteMember(
        `workspace\0${wsMainId}`,
        memEditorId,
        ownerSubject,
        {
          idempotencyKey: 'a0000000-0000-0000-0000-000000000074',
        },
      );
      expect(res.statusCode).toBe(400);
      expect(res.statusCode).not.toBe(500);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request and never 500 when workspaceId exceeds 10000 characters', async () => {
      const res = await deleteMember(
        'a'.repeat(10_000),
        memEditorId,
        ownerSubject,
        {
          idempotencyKey: 'a0000000-0000-0000-0000-000000000075',
        },
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).not.toBe(500);
    });

    it('returns 400 bad-request when memberId is not a UUID', async () => {
      const res = await deleteMember(wsMainId, 'not-a-uuid', ownerSubject, {
        idempotencyKey: 'a0000000-0000-0000-0000-000000000071',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request and never 500 when memberId contains a NUL byte', async () => {
      const res = await deleteMember(
        wsMainId,
        `member\0${memEditorId}`,
        ownerSubject,
        {
          idempotencyKey: 'a0000000-0000-0000-0000-000000000076',
        },
      );
      expect(res.statusCode).toBe(400);
      expect(res.statusCode).not.toBe(500);
      expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(res.json().code).toBe('bad-request');
    });

    it('returns 400 bad-request and never 500 when memberId exceeds 10000 characters', async () => {
      const res = await deleteMember(
        wsMainId,
        'b'.repeat(10_000),
        ownerSubject,
        {
          idempotencyKey: 'a0000000-0000-0000-0000-000000000077',
        },
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).not.toBe(500);
    });

    it('returns 401 unauthorized when Bearer token is missing', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${wsMainId}/members/${memEditorId}`,
        headers: {
          'idempotency-key': 'a0000000-0000-0000-0000-000000000072',
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().type).toBe(PROBLEM_TYPES.UNAUTHORIZED);
      expect(res.json().code).toBe('unauthorized');
    });

    it('returns 401 unauthorized when Bearer token is rejected by verifier', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/workspaces/${wsMainId}/members/${memEditorId}`,
        headers: {
          authorization: 'Bearer invalid-token',
          'idempotency-key': 'a0000000-0000-0000-0000-000000000073',
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().type).toBe(PROBLEM_TYPES.UNAUTHORIZED);
      expect(res.json().code).toBe('unauthorized');
    });
  });

  describe('Deferred Constraints Trigger Catch (SQLSTATE 23514)', () => {
    it('catches check_violation from enforceDeferredConstraints and maps to LAST_OWNER_REQUIRED (409) rather than 503', async () => {
      const pool = app.get(PostgresPool);
      const transaction = new PgTransaction(pool);
      const adapter = app.get(PostgresWorkspaceMemberAdapter);
      const idempotency = app.get(PostgresIdempotencyAdapter);

      const storeWrapper: WorkspaceMemberStore = {
        readMembership: (client, ws, sub) =>
          adapter.readMembership(client, ws, sub),
        listRoster: (client, ws, c, l) => adapter.listRoster(client, ws, c, l),
        readWorkspaceKind: (client, ws) =>
          adapter.readWorkspaceKind(client, ws),
        readMembershipById: (client, ws, mem) =>
          adapter.readMembershipById(client, ws, mem),
        retainsActiveOwner: () => Promise.resolve(true), // BYPASS pre-check!
        updateMemberRole: (client, ws, m, r, v) =>
          adapter.updateMemberRole(client, ws, m, r, v),
        deleteMember: (client, ws, m) => adapter.deleteMember(client, ws, m),
        enforceDeferredConstraints: (client) =>
          adapter.enforceDeferredConstraints(client),
        readRosterMember: (client, ws, m) =>
          adapter.readRosterMember(client, ws, m),
      };

      const testService = new WorkspaceMemberService(
        transaction,
        storeWrapper,
        idempotency,
      );

      const outcome = await testService.removeWorkspaceMember(
        soleOwnerSubject,
        wsSoleOwnerId,
        memSoleOwnerId,
        'a0000000-0000-0000-0000-000000000080',
      );

      expect(outcome.kind).toBe(
        WORKSPACE_MEMBER_REMOVE_OUTCOMES.LAST_OWNER_REQUIRED,
      );
    });
  });
});
