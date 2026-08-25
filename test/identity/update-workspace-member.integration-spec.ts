// Migrations under test: 202607150011_membership_write_rls.sql, 202607150012_last_owner_guard.sql, 202607150013_workspace_member_roster.sql
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdentityModule } from '../../src/identity/identity.module.js';
import { JoseJwtVerifier } from '../../src/platform/jose-jwt-verifier.js';
import { registerProblemFilter } from '../../src/identity/onboarding-problem.filter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PostgresWorkspaceMemberAdapter } from '../../src/identity/postgres-workspace-member.adapter.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';
import { WORKSPACE_MEMBER_UPDATE_OUTCOMES } from '../../src/identity/workspace-member.port.js';
import {
  WorkspaceMemberService,
  type WorkspaceMemberStore,
  type WorkspaceMemberTransaction,
} from '../../src/identity/workspace-member.service.js';
import { IDENTITY_PROBLEM_TYPES } from '../../src/identity/identity-problem-types.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('updateWorkspaceMember integration (PATCH /v1/workspaces/{workspaceId}/members/{memberId})', () => {
  let admin: Pool;
  let app: NestFastifyApplication;

  // Subjects
  const ownerSubject = subject(2001);
  const adminSubject = subject(2002);
  const editorSubject = subject(2003);
  const viewerSubject = subject(2004);
  const suspendedSubject = subject(2005);
  const nonMemberSubject = subject(2006);
  const otherOwnerSubject = subject(2007);
  const personalOwnerSubject = subject(2008);
  const soleOwnerSubject = subject(2009);
  const twoOwner1Subject = subject(2010);
  const twoOwner2Subject = subject(2011);
  const selfTwoOwner1Subject = subject(2012);
  const selfTwoOwner2Subject = subject(2013);
  const selfSoleOwnerSubject = subject(2014);
  const ifMatchOwnerSubject = subject(2015);
  const ifMatchViewerSubject = subject(2016);
  const concurTwo1Subject = subject(2017);
  const concurTwo2Subject = subject(2018);
  const concurThree1Subject = subject(2019);
  const concurThree2Subject = subject(2020);
  const concurThree3Subject = subject(2021);
  const statusCheckViewerSubject = subject(2022);
  const promoteEditorSubject = subject(2023);
  const noopSubject = subject(2024);
  const bothAdminSubject = subject(2025);
  const otherViewerSubject = subject(2026);
  const interleavingOwner1 = subject(2027);
  const interleavingOwner2 = subject(2028);
  const interleavingViewer = subject(2029);
  const secondMainOwnerSubject = subject(2030);

  // Workspaces
  const wsMainId = '00000000-0000-0000-0000-000000002100';
  const wsOtherId = '00000000-0000-0000-0000-000000002101';
  const wsPersonalId = '00000000-0000-0000-0000-000000002102';
  const wsSoleOwnerId = '00000000-0000-0000-0000-000000002103';
  const wsTwoOwnersId = '00000000-0000-0000-0000-000000002104';
  const wsSelfTwoOwnersId = '00000000-0000-0000-0000-000000002105';
  const wsSelfSoleOwnerId = '00000000-0000-0000-0000-000000002106';
  const wsIfMatchId = '00000000-0000-0000-0000-000000002107';
  const wsConcurTwoId = '00000000-0000-0000-0000-000000002108';
  const wsConcurThreeId = '00000000-0000-0000-0000-000000002109';
  const wsInterleavingId = '00000000-0000-0000-0000-000000002110';

  // Memberships
  const memOwnerId = '00000000-0000-0000-0000-000000002201';
  const memAdminId = '00000000-0000-0000-0000-000000002202';
  const memEditorId = '00000000-0000-0000-0000-000000002203';
  const memViewerId = '00000000-0000-0000-0000-000000002204';
  const memSuspendedId = '00000000-0000-0000-0000-000000002205';
  const memStatusCheckId = '00000000-0000-0000-0000-000000002206';
  const memPromoteEditorId = '00000000-0000-0000-0000-000000002207';
  const memNoopId = '00000000-0000-0000-0000-000000002208';
  const memBothAdminMainId = '00000000-0000-0000-0000-000000002209';

  const memOtherOwnerId = '00000000-0000-0000-0000-000000002210';
  const memBothAdminOtherId = '00000000-0000-0000-0000-000000002211';
  const memOtherViewerId = '00000000-0000-0000-0000-000000002212';
  const memSecondMainOwnerId = '00000000-0000-0000-0000-000000002213';
  const memPersonalId = '00000000-0000-0000-0000-000000002220';
  const memSoleOwnerId = '00000000-0000-0000-0000-000000002230';
  const memTwoOwner1Id = '00000000-0000-0000-0000-000000002241';
  const memTwoOwner2Id = '00000000-0000-0000-0000-000000002242';
  const memSelfTwoOwner1Id = '00000000-0000-0000-0000-000000002251';
  const memSelfTwoOwner2Id = '00000000-0000-0000-0000-000000002252';
  const memSelfSoleOwnerId = '00000000-0000-0000-0000-000000002260';
  const memIfMatchOwnerId = '00000000-0000-0000-0000-000000002271';
  const memIfMatchViewerId = '00000000-0000-0000-0000-000000002272';
  const memConcurTwo1Id = '00000000-0000-0000-0000-000000002281';
  const memConcurTwo2Id = '00000000-0000-0000-0000-000000002282';
  const memConcurThree1Id = '00000000-0000-0000-0000-000000002291';
  const memConcurThree2Id = '00000000-0000-0000-0000-000000002292';
  const memConcurThree3Id = '00000000-0000-0000-0000-000000002293';
  const memInterleavingOwner1Id = '00000000-0000-0000-0000-000000002301';
  const memInterleavingOwner2Id = '00000000-0000-0000-0000-000000002302';
  const memInterleavingViewerId = '00000000-0000-0000-0000-000000002303';

  const verifier = {
    verify: (token: string) => {
      if (token.startsWith('bearer-')) {
        const sub = token.replace('bearer-', '');
        return Promise.resolve({ subject: sub });
      }
      return Promise.reject(new Error('unauthorized'));
    },
  };

  function patchMember(
    workspaceId: string,
    memberId: string,
    caller: string,
    body: unknown,
    options: { ifMatch?: string } = {},
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}/members/${memberId}`,
      payload: body as Record<string, unknown>,
      headers: {
        authorization: `Bearer bearer-${caller}`,
        ...(options.ifMatch !== undefined
          ? { 'if-match': options.ifMatch }
          : {}),
      },
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
      [ownerSubject, 'owner@example.test', 'Owner User'],
      [adminSubject, 'admin@example.test', 'Admin User'],
      [editorSubject, 'editor@example.test', 'Editor User'],
      [viewerSubject, 'viewer@example.test', 'Viewer User'],
      [suspendedSubject, 'suspended@example.test', 'Suspended User'],
      [nonMemberSubject, 'nonmember@example.test', 'NonMember User'],
      [otherOwnerSubject, 'otherowner@example.test', 'OtherOwner User'],
      [personalOwnerSubject, 'personal@example.test', 'Personal User'],
      [soleOwnerSubject, 'sole@example.test', 'Sole User'],
      [twoOwner1Subject, 'two1@example.test', 'Two Owner 1'],
      [twoOwner2Subject, 'two2@example.test', 'Two Owner 2'],
      [selfTwoOwner1Subject, 'selftwo1@example.test', 'Self Two 1'],
      [selfTwoOwner2Subject, 'selftwo2@example.test', 'Self Two 2'],
      [selfSoleOwnerSubject, 'selfsole@example.test', 'Self Sole'],
      [ifMatchOwnerSubject, 'ifmatchowner@example.test', 'IfMatch Owner'],
      [ifMatchViewerSubject, 'ifmatchviewer@example.test', 'IfMatch Viewer'],
      [concurTwo1Subject, 'concurtwo1@example.test', 'Concur Two 1'],
      [concurTwo2Subject, 'concurtwo2@example.test', 'Concur Two 2'],
      [concurThree1Subject, 'concurthree1@example.test', 'Concur Three 1'],
      [concurThree2Subject, 'concurthree2@example.test', 'Concur Three 2'],
      [concurThree3Subject, 'concurthree3@example.test', 'Concur Three 3'],
      [
        statusCheckViewerSubject,
        'statuscheck@example.test',
        'Status Check User',
      ],
      [
        promoteEditorSubject,
        'promoteeditor@example.test',
        'Promote Editor User',
      ],
      [noopSubject, 'noop@example.test', 'Noop User'],
      [bothAdminSubject, 'bothadmin@example.test', 'Both Admin User'],
      [otherViewerSubject, 'otherviewer@example.test', 'Other Viewer User'],
      [
        interleavingOwner1,
        'interleaving1@example.test',
        'Interleaving Owner 1',
      ],
      [
        interleavingOwner2,
        'interleaving2@example.test',
        'Interleaving Owner 2',
      ],
      [interleavingViewer, 'interleavingv@example.test', 'Interleaving Viewer'],
      [
        secondMainOwnerSubject,
        'secondmainowner@example.test',
        'Second Main Owner',
      ],
    ] as const;

    for (const [id, email] of seedUsers) {
      await admin.query('insert into auth.users (id, email) values ($1, $2)', [
        id,
        email,
      ]);
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, seedUsers.find((u) => u[0] === id)![2]],
      );
    }

    // Seed Workspaces
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Main Workspace', 'shared', 'USD', null, $2),
              ($3, 'Other Workspace', 'shared', 'USD', null, $4),
              ($5, 'Sole Owner Workspace', 'family', 'USD', null, $6),
              ($7, 'Two Owners Workspace', 'shared', 'USD', null, $8),
              ($9, 'Self Two Owners Workspace', 'shared', 'USD', null, $10),
              ($11, 'Self Sole Workspace', 'family', 'USD', null, $12),
              ($13, 'If-Match Workspace', 'shared', 'USD', null, $14),
              ($15, 'Concurrent Two Workspace', 'shared', 'USD', null, $16),
              ($17, 'Concurrent Three Workspace', 'shared', 'USD', null, $18),
              ($19, 'Interleaving Workspace', 'shared', 'USD', null, $20)`,
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
        wsIfMatchId,
        ifMatchOwnerSubject,
        wsConcurTwoId,
        concurTwo1Subject,
        wsConcurThreeId,
        concurThree1Subject,
        wsInterleavingId,
        interleavingOwner1,
      ],
    );

    // Personal workspace
    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Personal Workspace', 'personal', 'USD', $2, $2)`,
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
        memAdminId,
        wsMainId,
        adminSubject,
        'administrator',
        'active',
        '2026-07-15T02:00:00.000Z',
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
        memViewerId,
        wsMainId,
        viewerSubject,
        'viewer',
        'active',
        '2026-07-15T04:00:00.000Z',
        1,
      ],
      [
        memSuspendedId,
        wsMainId,
        suspendedSubject,
        'owner',
        'suspended',
        '2026-07-15T05:00:00.000Z',
        1,
      ],
      [
        memStatusCheckId,
        wsMainId,
        statusCheckViewerSubject,
        'viewer',
        'active',
        '2026-07-15T06:00:00.000Z',
        1,
      ],
      [
        memPromoteEditorId,
        wsMainId,
        promoteEditorSubject,
        'editor',
        'active',
        '2026-07-15T06:30:00.000Z',
        1,
      ],
      [
        memNoopId,
        wsMainId,
        noopSubject,
        'viewer',
        'active',
        '2026-07-15T06:45:00.000Z',
        1,
      ],
      [
        memOtherOwnerId,
        wsOtherId,
        otherOwnerSubject,
        'owner',
        'active',
        '2026-07-15T07:00:00.000Z',
        1,
      ],
      [
        memSoleOwnerId,
        wsSoleOwnerId,
        soleOwnerSubject,
        'owner',
        'active',
        '2026-07-15T08:00:00.000Z',
        1,
      ],
      [
        memTwoOwner1Id,
        wsTwoOwnersId,
        twoOwner1Subject,
        'owner',
        'active',
        '2026-07-15T09:00:00.000Z',
        1,
      ],
      [
        memTwoOwner2Id,
        wsTwoOwnersId,
        twoOwner2Subject,
        'owner',
        'active',
        '2026-07-15T10:00:00.000Z',
        1,
      ],
      [
        memSelfTwoOwner1Id,
        wsSelfTwoOwnersId,
        selfTwoOwner1Subject,
        'owner',
        'active',
        '2026-07-15T11:00:00.000Z',
        1,
      ],
      [
        memSelfTwoOwner2Id,
        wsSelfTwoOwnersId,
        selfTwoOwner2Subject,
        'owner',
        'active',
        '2026-07-15T12:00:00.000Z',
        1,
      ],
      [
        memSelfSoleOwnerId,
        wsSelfSoleOwnerId,
        selfSoleOwnerSubject,
        'owner',
        'active',
        '2026-07-15T13:00:00.000Z',
        1,
      ],
      [
        memIfMatchOwnerId,
        wsIfMatchId,
        ifMatchOwnerSubject,
        'owner',
        'active',
        '2026-07-15T14:00:00.000Z',
        1,
      ],
      [
        memIfMatchViewerId,
        wsIfMatchId,
        ifMatchViewerSubject,
        'viewer',
        'active',
        '2026-07-15T15:00:00.000Z',
        7,
      ],
      [
        memConcurTwo1Id,
        wsConcurTwoId,
        concurTwo1Subject,
        'owner',
        'active',
        '2026-07-15T16:00:00.000Z',
        1,
      ],
      [
        memConcurTwo2Id,
        wsConcurTwoId,
        concurTwo2Subject,
        'owner',
        'active',
        '2026-07-15T17:00:00.000Z',
        1,
      ],
      [
        memConcurThree1Id,
        wsConcurThreeId,
        concurThree1Subject,
        'owner',
        'active',
        '2026-07-15T18:00:00.000Z',
        1,
      ],
      [
        memConcurThree2Id,
        wsConcurThreeId,
        concurThree2Subject,
        'owner',
        'active',
        '2026-07-15T19:00:00.000Z',
        1,
      ],
      [
        memConcurThree3Id,
        wsConcurThreeId,
        concurThree3Subject,
        'owner',
        'active',
        '2026-07-15T20:00:00.000Z',
        1,
      ],
      [
        memBothAdminMainId,
        wsMainId,
        bothAdminSubject,
        'administrator',
        'active',
        '2026-07-15T21:00:00.000Z',
        1,
      ],
      [
        memBothAdminOtherId,
        wsOtherId,
        bothAdminSubject,
        'administrator',
        'active',
        '2026-07-15T21:05:00.000Z',
        1,
      ],
      [
        memOtherViewerId,
        wsOtherId,
        otherViewerSubject,
        'viewer',
        'active',
        '2026-07-15T21:10:00.000Z',
        1,
      ],
      [
        memSecondMainOwnerId,
        wsMainId,
        secondMainOwnerSubject,
        'owner',
        'active',
        '2026-07-15T21:15:00.000Z',
        1,
      ],
      [
        memInterleavingOwner1Id,
        wsInterleavingId,
        interleavingOwner1,
        'owner',
        'active',
        '2026-07-15T21:20:00.000Z',
        1,
      ],
      [
        memInterleavingOwner2Id,
        wsInterleavingId,
        interleavingOwner2,
        'owner',
        'active',
        '2026-07-15T21:25:00.000Z',
        1,
      ],
      [
        memInterleavingViewerId,
        wsInterleavingId,
        interleavingViewer,
        'viewer',
        'active',
        '2026-07-15T21:30:00.000Z',
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

    // Boot NestFastifyApplication with 10s timeout on PgTransaction for concurrent tests
    const pool = new PostgresPool(PostgresConfig.fromUrl(url));
    const transaction = new PgTransaction(pool, {
      callbackTimeoutMs: 10_000,
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 10_000,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    })
      .overrideProvider(JoseJwtVerifier)
      .useValue(verifier)
      .overrideProvider(PostgresPool)
      .useValue(pool)
      .overrideProvider(PgTransaction)
      .useValue(transaction)
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

  // Happy paths (1-7)
  describe('Happy paths', () => {
    it('1. an owner promotes a viewer to editor: 200, body role editor, ETag is the bumped version', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'editor',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe('"2"');
      const body = response.json();
      expect(body.role).toBe('editor');
    });

    it('2. an administrator promotes a viewer to editor: 200', async () => {
      const response = await patchMember(
        wsMainId,
        memStatusCheckId,
        adminSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.role).toBe('editor');
    });

    it('3. an owner promotes an editor to owner: 200', async () => {
      const response = await patchMember(
        wsMainId,
        memPromoteEditorId,
        ownerSubject,
        { role: 'owner' },
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.role).toBe('owner');
    });

    it('4. a no-op update (same role): 200 and the version still increments', async () => {
      const before = await admin.query<{ version: number }>(
        'select version from public.workspace_memberships where id = $1',
        [memNoopId],
      );
      const prevVersion = before.rows[0]!.version;

      const response = await patchMember(
        wsMainId,
        memNoopId,
        ownerSubject,
        { role: 'viewer' }, // currently viewer
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe(`"${prevVersion + 1}"`);
    });

    it('5. the 200 body contains id, userId, displayName, role, status, joinedAt, and Object.hasOwn(body, "version") is false', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'editor',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(memViewerId);
      expect(body.userId).toBe(viewerSubject);
      expect(typeof body.displayName).toBe('string');
      expect(body.role).toBe('editor');
      expect(body.status).toBe('active');
      expect(typeof body.joinedAt).toBe('string');
      expect(Object.hasOwn(body, 'version')).toBe(false);
    });

    it('6. id is the MEMBERSHIP id and userId is the PROFILE id, and they are DIFFERENT values', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'editor',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(memViewerId);
      expect(body.userId).toBe(viewerSubject);
      expect(memViewerId).not.toBe(viewerSubject);
      expect(body.id).not.toBe(body.userId);
    });

    it('7. an owner caller sees email in the 200 body; an administrator caller sees it too', async () => {
      const ownerResp = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'editor',
      });
      expect(ownerResp.statusCode).toBe(200);
      expect(ownerResp.json().email).toBe('viewer@example.test');

      const adminResp = await patchMember(wsMainId, memViewerId, adminSubject, {
        role: 'editor',
      });
      expect(adminResp.statusCode).toBe(200);
      expect(adminResp.json().email).toBe('viewer@example.test');
    });
  });

  // Authorization (8-14)
  describe('Authorization', () => {
    it('8. an editor caller receives 403 forbidden', async () => {
      const response = await patchMember(wsMainId, memViewerId, editorSubject, {
        role: 'viewer',
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(body.code).toBe('forbidden');
    });

    it('9. a viewer caller receives 403 forbidden', async () => {
      const response = await patchMember(wsMainId, memViewerId, viewerSubject, {
        role: 'viewer',
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(body.code).toBe('forbidden');
    });

    it('10. a suspended owner receives 403 forbidden', async () => {
      const response = await patchMember(
        wsMainId,
        memViewerId,
        suspendedSubject,
        { role: 'viewer' },
      );
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(body.code).toBe('forbidden');
    });

    it('positive control for 8, 9, and 10: the identical request (memViewerId with role viewer) from an active owner succeeds: 200', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'viewer',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().role).toBe('viewer');
    });

    it('11. a non-member receives 404 not-found', async () => {
      const response = await patchMember(
        wsMainId,
        memViewerId,
        nonMemberSubject,
        { role: 'viewer' },
      );
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(body.code).toBe('not-found');
    });

    it('12. an administrator demoting an owner receives 403 forbidden', async () => {
      const response = await patchMember(wsMainId, memOwnerId, adminSubject, {
        role: 'editor',
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(body.code).toBe('forbidden');
    });

    it('positive control for 12: an owner demoting an owner (memOwnerId to editor) when another owner exists succeeds: 200', async () => {
      // wsMainId retains secondMainOwnerSubject as an active owner, so demoting memOwnerId succeeds.
      const response = await patchMember(wsMainId, memOwnerId, ownerSubject, {
        role: 'editor',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().role).toBe('editor');

      // Restore memOwnerId back to owner for subsequent tests
      await admin.query(
        `update public.workspace_memberships set role = 'owner', version = version + 1 where id = $1`,
        [memOwnerId],
      );
    });

    it('13. an administrator setting role owner receives 403 forbidden', async () => {
      const response = await patchMember(wsMainId, memViewerId, adminSubject, {
        role: 'owner',
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.FORBIDDEN);
      expect(body.code).toBe('forbidden');
    });

    it('14. positive control for 13: the identical request from an owner succeeds: 200', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'owner',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().role).toBe('owner');
    });
  });

  // Targeting (15-18)
  describe('Targeting', () => {
    it('15. a memberId that exists but belongs to a DIFFERENT workspace (pins RLS policy): 404 not-found, and the other workspace row is verifiably unchanged', async () => {
      const before = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memOtherOwnerId],
      );
      const prevRole = before.rows[0]!.role;
      const prevVersion = before.rows[0]!.version;

      const response = await patchMember(
        wsMainId,
        memOtherOwnerId,
        ownerSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(body.code).toBe('not-found');

      const after = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memOtherOwnerId],
      );
      expect(after.rows[0]!.role).toBe(prevRole);
      expect(after.rows[0]!.version).toBe(prevVersion);
    });

    it('a memberId from another workspace the caller ALSO administers answers 404 and leaves that row untouched', async () => {
      const before = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memOtherViewerId],
      );
      const prevRole = before.rows[0]!.role;
      const prevVersion = before.rows[0]!.version;

      // bothAdminSubject administers BOTH wsMainId and wsOtherId. Under RLS,
      // application_reads_administered_membership would make memOtherViewerId visible
      // to bothAdminSubject because bothAdminSubject administers wsOtherId.
      // Therefore, only the workspace_id predicate in readMembershipById enforces
      // the workspace boundary and produces 404 here.
      const response = await patchMember(
        wsMainId,
        memOtherViewerId,
        bothAdminSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(body.code).toBe('not-found');

      const after = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memOtherViewerId],
      );
      expect(after.rows[0]!.role).toBe(prevRole);
      expect(after.rows[0]!.version).toBe(prevVersion);
    });

    it('16. a well-formed UUID that matches no membership: 404 not-found', async () => {
      const nonExistentUuid = '00000000-0000-0000-0000-000000009999';
      const response = await patchMember(
        wsMainId,
        nonExistentUuid,
        ownerSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(body.code).toBe('not-found');
    });

    it('17. a memberId that is a valid PROFILE id but not a membership id: 404 not-found', async () => {
      // viewerSubject is a valid profile id, but not the membership id
      const response = await patchMember(
        wsMainId,
        viewerSubject,
        ownerSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(body.code).toBe('not-found');
    });

    it('18. a non-UUID memberId: 400 bad-request; also non-UUID workspaceId: 400 bad-request', async () => {
      const resBadMember = await patchMember(
        wsMainId,
        'not-a-uuid',
        ownerSubject,
        { role: 'editor' },
      );
      expect(resBadMember.statusCode).toBe(400);
      expect(resBadMember.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(resBadMember.json().code).toBe('bad-request');

      const resBadWs = await patchMember(
        'not-a-uuid',
        memViewerId,
        ownerSubject,
        { role: 'editor' },
      );
      expect(resBadWs.statusCode).toBe(400);
      expect(resBadWs.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
      expect(resBadWs.json().code).toBe('bad-request');
    });

    it('a non-UUID memberId with NUL byte: 400 bad-request; and overlong memberId (10 000 chars): 4xx and never 500; same for workspaceId', async () => {
      for (const badMem of [`member\0${memViewerId}`, 'm'.repeat(80)]) {
        const res = await patchMember(wsMainId, badMem, ownerSubject, {
          role: 'editor',
        });
        expect(res.statusCode).toBe(400);
        expect(res.statusCode).not.toBe(500);
        expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
        expect(res.json().code).toBe('bad-request');
      }
      for (const overlongMem of ['m'.repeat(10_000)]) {
        const res = await patchMember(wsMainId, overlongMem, ownerSubject, {
          role: 'editor',
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.statusCode).not.toBe(500);
      }
      for (const badWs of [`ws\0${wsMainId}`, 'w'.repeat(80)]) {
        const res = await patchMember(badWs, memViewerId, ownerSubject, {
          role: 'editor',
        });
        expect(res.statusCode).toBe(400);
        expect(res.statusCode).not.toBe(500);
        expect(res.json().type).toBe(PROBLEM_TYPES.BAD_REQUEST);
        expect(res.json().code).toBe('bad-request');
      }
      for (const overlongWs of ['w'.repeat(10_000)]) {
        const res = await patchMember(overlongWs, memViewerId, ownerSubject, {
          role: 'editor',
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.statusCode).not.toBe(500);
      }
    });
  });

  // Conflicts (19-23)
  describe('Conflicts', () => {
    it('19. a personal workspace: 409 personal-workspace-membership', async () => {
      const response = await patchMember(
        wsPersonalId,
        memPersonalId,
        personalOwnerSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.type).toBe(
        IDENTITY_PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
      );
      expect(body.code).toBe('personal-workspace-membership');
    });

    it('20. demoting the SOLE active owner: 409 last-owner-required, row still reads owner, statusCode !== 503, no retry-after', async () => {
      const response = await patchMember(
        wsSoleOwnerId,
        memSoleOwnerId,
        soleOwnerSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(409);
      expect(response.statusCode).not.toBe(503);
      expect(response.headers['retry-after']).toBeUndefined();
      const body = response.json();
      expect(body.type).toBe(IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED);
      expect(body.code).toBe('last-owner-required');

      const check = await admin.query<{ role: string }>(
        'select role from public.workspace_memberships where id = $1',
        [memSoleOwnerId],
      );
      expect(check.rows[0]!.role).toBe('owner');
    });

    it('21. positive control for 20: demoting one of TWO owners succeeds: 200', async () => {
      const response = await patchMember(
        wsTwoOwnersId,
        memTwoOwner1Id,
        twoOwner1Subject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().role).toBe('editor');

      const check = await admin.query<{ role: string }>(
        'select role from public.workspace_memberships where id = $1',
        [memTwoOwner1Id],
      );
      expect(check.rows[0]!.role).toBe('editor');
    });

    it('22. an owner demoting THEMSELVES while another owner exists: 200, and the body OMITS email', async () => {
      const response = await patchMember(
        wsSelfTwoOwnersId,
        memSelfTwoOwner1Id,
        selfTwoOwner1Subject, // Caller is selfTwoOwner1
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.role).toBe('editor');
      expect(Object.hasOwn(body, 'email')).toBe(false);
    });

    it('23. an owner demoting themselves as the SOLE owner: 409 last-owner-required', async () => {
      const response = await patchMember(
        wsSelfSoleOwnerId,
        memSelfSoleOwnerId,
        selfSoleOwnerSubject,
        { role: 'editor' },
      );
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.type).toBe(IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED);
      expect(body.code).toBe('last-owner-required');
    });
  });

  // Optimistic concurrency (24-29)
  describe('Optimistic concurrency', () => {
    it('a version committed between the If-Match pre-check and the UPDATE is not overwritten: the request answers 412 and the concurrent change survives', async () => {
      // Direct driver with two raw PoolClients (no PgTransaction to avoid fixed lock_timeout).
      // Interleaving mechanism:
      // The store wrapper intercepts readMembershipById (step 8/11 pre-check). After reading the
      // initial version (1), a second PoolClient as co-owner interleavingOwner2 commits an UPDATE
      // to that same membership row, bumping its version to 2.
      // When the service's updateMemberRole executes its atomic SQL UPDATE predicate
      // (and ($4::integer[] is null or version = any($4::integer[]))), the version mismatch
      // causes 0 rows to be updated, and the residual branch answers 412 (VERSION_CONFLICT).
      const rawTransaction: WorkspaceMemberTransaction = {
        run: async (sub, callback) => {
          const client = await admin.connect();
          try {
            await client.query('begin');
            await client.query('set local role savia_application');
            await client.query(
              "select set_config('app.subject_id', $1, true)",
              [sub],
            );
            const result = await callback(client);
            await client.query('commit');
            return result;
          } catch (err) {
            await client.query('rollback').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        },
        runRead: async (sub, callback) => {
          const client = await admin.connect();
          try {
            await client.query('begin read only');
            await client.query('set local role savia_application');
            await client.query(
              "select set_config('app.subject_id', $1, true)",
              [sub],
            );
            const result = await callback(client);
            await client.query('rollback');
            return result;
          } catch (err) {
            await client.query('rollback').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        },
      };

      let targetReadCount = 0;
      const realStore = new PostgresWorkspaceMemberAdapter();
      const storeWrapper: WorkspaceMemberStore = {
        readMembership: (c, w, s) => realStore.readMembership(c, w, s),
        listRoster: (c, w, cur, l) => realStore.listRoster(c, w, cur, l),
        readWorkspaceKind: (c, w) => realStore.readWorkspaceKind(c, w),
        readMembershipById: async (c, w, m) => {
          targetReadCount++;
          const res = await realStore.readMembershipById(c, w, m);
          // Force interleaving: competing commit lands after readMembershipById (first call / pre-check) and before UPDATE
          if (targetReadCount === 1) {
            const compClient = await admin.connect();
            try {
              await compClient.query('begin');
              await compClient.query('set local role savia_application');
              await compClient.query(
                "select set_config('app.subject_id', $1, true)",
                [interleavingOwner2],
              );
              await compClient.query(
                `update public.workspace_memberships
                    set role = 'editor', version = version + 1
                  where id = $1 and workspace_id = $2`,
                [m, w],
              );
              await compClient.query('commit');
            } finally {
              compClient.release();
            }
          }
          return res;
        },
        retainsActiveOwner: (c, w, e) => realStore.retainsActiveOwner(c, w, e),
        updateMemberRole: (c, w, m, r, ev) =>
          realStore.updateMemberRole(c, w, m, r, ev),
        deleteMember: (c, w, m) => realStore.deleteMember(c, w, m),
        enforceDeferredConstraints: (c) =>
          realStore.enforceDeferredConstraints(c),
        readRosterMember: (c, w, m) => realStore.readRosterMember(c, w, m),
      };

      const directService = new WorkspaceMemberService(
        rawTransaction,
        storeWrapper,
      );
      const outcome = await directService.updateWorkspaceMember(
        interleavingOwner1,
        wsInterleavingId,
        memInterleavingViewerId,
        { role: 'administrator' },
        1, // Expected version 1
      );

      // Assert 412 (VERSION_CONFLICT)
      expect(outcome.kind).toBe(
        WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT,
      );

      // Assert competing change is still present and was not overwritten by the caller
      const surviving = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memInterleavingViewerId],
      );
      expect(surviving.rows[0]!.role).toBe('editor');
      expect(surviving.rows[0]!.version).toBe(2);
    });

    it('24. correct If-Match: 200', async () => {
      const response = await patchMember(
        wsIfMatchId,
        memIfMatchViewerId,
        ifMatchOwnerSubject,
        { role: 'editor' },
        { ifMatch: '"7"' },
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe('"8"');
    });

    it('25. stale If-Match: 412 precondition-failed, and the row is unchanged', async () => {
      const before = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memIfMatchViewerId],
      );
      const prevRole = before.rows[0]!.role;
      const currentVersion = before.rows[0]!.version;

      const response = await patchMember(
        wsIfMatchId,
        memIfMatchViewerId,
        ifMatchOwnerSubject,
        { role: 'viewer' },
        { ifMatch: '"1"' }, // Stale: current is 8
      );
      expect(response.statusCode).toBe(412);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.PRECONDITION_FAILED);
      expect(body.code).toBe('precondition-failed');

      const after = await admin.query<{ role: string; version: number }>(
        'select role, version from public.workspace_memberships where id = $1',
        [memIfMatchViewerId],
      );
      expect(after.rows[0]!.role).toBe(prevRole);
      expect(after.rows[0]!.version).toBe(currentVersion);
    });

    it('26. If-Match: * on an existing member: 200', async () => {
      const response = await patchMember(
        wsIfMatchId,
        memIfMatchViewerId,
        ifMatchOwnerSubject,
        { role: 'viewer' },
        { ifMatch: '*' },
      );
      expect(response.statusCode).toBe(200);
    });

    it('If-Match: * on a memberId that does not exist answers 404, not 412 — a deliberate RFC 9110 deviation shared with updateWorkspace', async () => {
      const nonExistentUuid = '00000000-0000-0000-0000-000000009999';
      const response = await patchMember(
        wsIfMatchId,
        nonExistentUuid,
        ifMatchOwnerSubject,
        { role: 'viewer' },
        { ifMatch: '*' },
      );
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.NOT_FOUND);
      expect(body.code).toBe('not-found');
    });

    it('27. If-Match: "1", "9" where current version is 9: 200 (list form)', async () => {
      const cur = await admin.query<{ version: number }>(
        'select version from public.workspace_memberships where id = $1',
        [memIfMatchViewerId],
      );
      const currentVersion = cur.rows[0]!.version;

      const response = await patchMember(
        wsIfMatchId,
        memIfMatchViewerId,
        ifMatchOwnerSubject,
        { role: 'editor' },
        { ifMatch: `"1", "${currentVersion}"` },
      );
      expect(response.statusCode).toBe(200);
    });

    it('28. malformed or over-large If-Match values, each 412 and never 500: W/"7", "007", 7, "", "99999999999999999999", "7\\0", "\\0"', async () => {
      for (const badHeader of [
        'W/"7"',
        '"007"',
        '7',
        '""',
        '"99999999999999999999"',
        '"7\0"',
        '\0',
      ]) {
        const response = await patchMember(
          wsIfMatchId,
          memIfMatchViewerId,
          ifMatchOwnerSubject,
          { role: 'editor' },
          { ifMatch: badHeader },
        );
        expect(response.statusCode).toBe(412);
        expect(response.statusCode).not.toBe(500);
        const body = response.json();
        expect(body.type).toBe(PROBLEM_TYPES.PRECONDITION_FAILED);
        expect(body.code).toBe('precondition-failed');
      }
    });

    it('29. no If-Match at all: 200 (optional header)', async () => {
      const response = await patchMember(
        wsIfMatchId,
        memIfMatchViewerId,
        ifMatchOwnerSubject,
        { role: 'viewer' },
      );
      expect(response.statusCode).toBe(200);
    });
  });

  // Body validation (30-36)
  describe('Body validation', () => {
    it('30. {}: 422 unprocessable', async () => {
      const response = await patchMember(
        wsMainId,
        memViewerId,
        ownerSubject,
        {},
      );
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });

    it('31. {"role":"admin"}: 422 unprocessable', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'admin',
      });
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });

    it('32. {"role":"OWNER"}: 422 unprocessable', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'OWNER',
      });
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });

    it('33. {"role":"editor","status":"suspended"}: 422 unprocessable and member status is unchanged afterwards', async () => {
      const before = await admin.query<{ status: string }>(
        'select status from public.workspace_memberships where id = $1',
        [memStatusCheckId],
      );
      expect(before.rows[0]!.status).toBe('active');

      const response = await patchMember(
        wsMainId,
        memStatusCheckId,
        ownerSubject,
        { role: 'editor', status: 'suspended' },
      );
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');

      const after = await admin.query<{ status: string }>(
        'select status from public.workspace_memberships where id = $1',
        [memStatusCheckId],
      );
      expect(after.rows[0]!.status).toBe('active');
    });

    it('34. body is an array: 422 unprocessable', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, [
        { role: 'editor' },
      ]);
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });

    it('35. {"role": null}: 422 unprocessable', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: null,
      });
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });

    it('36. a role string containing a NUL byte: 422 unprocessable and never 500', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'editor\0',
      });
      expect(response.statusCode).toBe(422);
      expect(response.statusCode).not.toBe(500);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });

    it('an over-long role string (10 000 characters): 422 unprocessable and never 500', async () => {
      const response = await patchMember(wsMainId, memViewerId, ownerSubject, {
        role: 'a'.repeat(10_000),
      });
      expect(response.statusCode).toBe(422);
      expect(response.statusCode).not.toBe(500);
      const body = response.json();
      expect(body.type).toBe(PROBLEM_TYPES.UNPROCESSABLE);
      expect(body.code).toBe('unprocessable');
    });
  });

  // Concurrency (37)
  describe('Concurrency', () => {
    it('37. two concurrent demotions of two DIFFERENT co-owners of a two-owner workspace cannot both succeed; positive control: three-owner workspace lets both succeed', async () => {
      // Part A: Two-owner workspace: concurTwo1Subject demotes memConcurTwo1Id, concurTwo2Subject demotes memConcurTwo2Id
      const p1 = patchMember(
        wsConcurTwoId,
        memConcurTwo1Id,
        concurTwo1Subject,
        { role: 'editor' },
      );
      await new Promise((r) => setTimeout(r, 25));
      const p2 = patchMember(
        wsConcurTwoId,
        memConcurTwo2Id,
        concurTwo2Subject,
        { role: 'editor' },
      );

      const [res1, res2] = await Promise.all([p1, p2]);
      const statusCodes = [res1.statusCode, res2.statusCode];

      // Exactly one succeeds (200) and the other fails (409 last-owner-required)
      expect(statusCodes).toContain(200);
      expect(statusCodes.filter((s) => s === 200).length).toBe(1);
      expect(statusCodes).toContain(409);

      const loser = res1.statusCode === 409 ? res1 : res2;
      expect(loser.json().type).toBe(
        IDENTITY_PROBLEM_TYPES.LAST_OWNER_REQUIRED,
      );
      expect(loser.json().code).toBe('last-owner-required');

      // Verify at least one active owner remains
      const remainingTwo = await admin.query<{ count: number }>(
        `select count(*)::int as count from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'`,
        [wsConcurTwoId],
      );
      expect(remainingTwo.rows[0]!.count).toBeGreaterThanOrEqual(1);

      // Part B: Positive control: three-owner workspace lets both concurrent demotions succeed
      const p3 = patchMember(
        wsConcurThreeId,
        memConcurThree1Id,
        concurThree1Subject,
        { role: 'editor' },
      );
      await new Promise((r) => setTimeout(r, 25));
      const p4 = patchMember(
        wsConcurThreeId,
        memConcurThree2Id,
        concurThree2Subject,
        { role: 'editor' },
      );

      const [res3, res4] = await Promise.all([p3, p4]);
      expect(res3.statusCode).toBe(200);
      expect(res4.statusCode).toBe(200);

      const remainingThree = await admin.query<{
        count: number;
        profile_id: string;
      }>(
        `select count(*)::int as count from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'`,
        [wsConcurThreeId],
      );
      expect(remainingThree.rows[0]!.count).toBe(1);

      const surviving = await admin.query<{ profile_id: string }>(
        `select profile_id from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'`,
        [wsConcurThreeId],
      );
      expect(surviving.rows[0]!.profile_id).toBe(concurThree3Subject);
    });
  });
});
