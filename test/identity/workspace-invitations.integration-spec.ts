import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresIdempotencyAdapter } from '../../src/identity/postgres-idempotency.adapter.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import { PostgresWorkspaceInvitationAdapter } from '../../src/identity/postgres-workspace-invitation.adapter.js';
import { decodeCursor } from '../../src/platform/cursor.js';
import {
  WORKSPACE_INVITATION_CREATE_OUTCOMES,
  WORKSPACE_INVITATION_LIST_OUTCOMES,
  type WorkspaceInvitationPort,
} from '../../src/identity/workspace-invitation.port.js';
import {
  isPendingEmailUniqueViolation,
  WorkspaceInvitationService,
} from '../../src/identity/workspace-invitation.service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('Workspace invitations integration suite (RULINGS 18, 19, 20, 22, 24, 25, 27)', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresWorkspaceInvitationAdapter();
  const idempotencyAdapter = new PostgresIdempotencyAdapter();
  let service: WorkspaceInvitationPort;

  const ownerA = subject(821);
  const adminB = subject(822);
  const editorC = subject(823);
  const viewerD = subject(824);
  const memberActive = subject(825);
  const memberSuspended = subject(826);
  const stranger = subject(827);

  const wsSharedId = '00000000-0000-0000-0000-000000000881';
  const wsPersonalId = '00000000-0000-0000-0000-000000000882';
  const wsPaginationId = '00000000-0000-0000-0000-000000000883';

  const memOwnerAId = '00000000-0000-0000-0000-000000000891';
  const memAdminBId = '00000000-0000-0000-0000-000000000892';
  const memEditorCId = '00000000-0000-0000-0000-000000000893';
  const memViewerDId = '00000000-0000-0000-0000-000000000894';
  const memActiveId = '00000000-0000-0000-0000-000000000895';
  const memSuspendedId = '00000000-0000-0000-0000-000000000896';
  const memPersonalOwnerId = '00000000-0000-0000-0000-000000000897';
  const memPaginationOwnerId = '00000000-0000-0000-0000-000000000898';

  async function asSubject<T>(
    subjectId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subjectId,
      ]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 5_000 });
    service = new WorkspaceInvitationService(
      transaction,
      adapter,
      idempotencyAdapter,
    );

    await admin.query(
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12), ($13, $14)`,
      [
        ownerA,
        'owner-a-inv@example.test',
        adminB,
        'admin-b-inv@example.test',
        editorC,
        'editor-c-inv@example.test',
        viewerD,
        'viewer-d-inv@example.test',
        memberActive,
        'active-member@example.test',
        memberSuspended,
        'suspended-member@example.test',
        stranger,
        'stranger@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'owner-a-inv@example.test', 'Owner A'],
      [adminB, 'admin-b-inv@example.test', 'Admin B'],
      [editorC, 'editor-c-inv@example.test', 'Editor C'],
      [viewerD, 'viewer-d-inv@example.test', 'Viewer D'],
      [memberActive, 'active-member@example.test', 'Active Member'],
      [memberSuspended, 'suspended-member@example.test', 'Suspended Member'],
      [stranger, 'stranger@example.test', 'Stranger'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Shared Workspace Invitations', 'shared', 'USD', null, $2),
              ($3, 'Personal Workspace Invitations', 'personal', 'USD', $4, $4),
              ($5, 'Pagination Workspace Invitations', 'shared', 'USD', null, $2)`,
      [wsSharedId, ownerA, wsPersonalId, ownerA, wsPaginationId],
    );

    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'administrator', 'active'),
              ($7, $8, $9, 'editor', 'active'),
              ($10, $11, $12, 'viewer', 'active'),
              ($13, $14, $15, 'editor', 'active'),
              ($16, $17, $18, 'viewer', 'suspended'),
              ($19, $20, $21, 'owner', 'active'),
              ($22, $23, $24, 'owner', 'active')`,
      [
        memOwnerAId,
        wsSharedId,
        ownerA,
        memAdminBId,
        wsSharedId,
        adminB,
        memEditorCId,
        wsSharedId,
        editorC,
        memViewerDId,
        wsSharedId,
        viewerD,
        memActiveId,
        wsSharedId,
        memberActive,
        memSuspendedId,
        wsSharedId,
        memberSuspended,
        memPersonalOwnerId,
        wsPersonalId,
        ownerA,
        memPaginationOwnerId,
        wsPaginationId,
        ownerA,
      ],
    );
    await admin.query('commit');
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('RULING 18: freshly created invitation expires_at is now() + 7 days by DATABASE clock', async () => {
    const outcome = await service.createWorkspaceInvitation(
      ownerA,
      wsSharedId,
      { email: 'ruling18@example.test', role: 'viewer' },
      '00000000-0000-0000-0000-000000000118',
    );

    expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED);
    if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED) {
      const invId = outcome.invitation.id;
      // Assert against database clock `now()`
      const dbCheck = await admin.query<{
        diffSeconds: number;
        expiresAtIso: string;
      }>(
        `select extract(epoch from (expires_at - (created_at + interval '7 days'))) as "diffSeconds",
                expires_at as "expiresAtIso"
           from public.workspace_invitations
          where id = $1`,
        [invId],
      );
      expect(Math.abs(Number(dbCheck.rows[0]?.diffSeconds))).toBeLessThan(1);
    }
  });

  it("RULING 19: pending row whose expires_at is in past projects status = 'expired' while stored column reads pending", async () => {
    const pastInvId = '00000000-0000-0000-0000-000000000119';
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at, created_at)
       values ($1, $2, $3, 'expired-row@example.test', 'editor', 'pending', now() - interval '1 hour', now() - interval '8 days')`,
      [pastInvId, wsSharedId, ownerA],
    );

    // 1. Assert STORED column in database still reads 'pending'
    const stored = await admin.query<{ status: string }>(
      `select status from public.workspace_invitations where id = $1`,
      [pastInvId],
    );
    expect(stored.rows[0]?.status).toBe('pending');

    // 2. Assert PROJECTION through adapter / service reads 'expired'
    const listOutcome = await service.listWorkspaceInvitations(
      ownerA,
      wsSharedId,
      { limit: 50 },
    );
    expect(listOutcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.OK);
    if (listOutcome.kind === WORKSPACE_INVITATION_LIST_OUTCOMES.OK) {
      const item = listOutcome.page.items.find((i) => i.id === pastInvId);
      expect(item).toBeDefined();
      expect(item?.status).toBe('expired');
    }
  });

  it('RULING 20: expired pending invitation is revoked and replaced, leaving exactly one pending row', async () => {
    const expiredEmail = 'replace-me@example.test';
    const oldInvId = '00000000-0000-0000-0000-000000000120';
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at, created_at)
       values ($1, $2, $3, $4, 'viewer', 'pending', now() - interval '1 day', now() - interval '8 days')`,
      [oldInvId, wsSharedId, ownerA, expiredEmail],
    );

    const outcome = await service.createWorkspaceInvitation(
      ownerA,
      wsSharedId,
      { email: expiredEmail, role: 'editor' },
      '00000000-0000-0000-0000-000000000220',
    );
    expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED);

    // Assert old row is revoked
    const oldRow = await admin.query<{ status: string }>(
      `select status from public.workspace_invitations where id = $1`,
      [oldInvId],
    );
    expect(oldRow.rows[0]?.status).toBe('revoked');

    // Assert exactly ONE pending row exists for this email
    const pendingRows = await admin.query<{ count: string }>(
      `select count(*)::text as count
         from public.workspace_invitations
        where workspace_id = $1 and lower(email) = lower($2) and status = 'pending'`,
      [wsSharedId, expiredEmail],
    );
    expect(pendingRows.rows[0]?.count).toBe('1');
  });

  it('RULING 20: unexpired pending invitation refuses creation and existing row is untouched', async () => {
    const activeEmail = 'active-pending@example.test';
    const activeInvId = '00000000-0000-0000-0000-000000000320';
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at, created_at)
       values ($1, $2, $3, $4, 'viewer', 'pending', now() + interval '5 days', now())`,
      [activeInvId, wsSharedId, ownerA, activeEmail],
    );

    const outcome = await service.createWorkspaceInvitation(
      ownerA,
      wsSharedId,
      { email: activeEmail, role: 'editor' },
      '00000000-0000-0000-0000-000000000420',
    );
    expect(outcome.kind).toBe(
      WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING,
    );

    // Existing row untouched
    const existing = await admin.query<{ status: string; role: string }>(
      `select status, role from public.workspace_invitations where id = $1`,
      [activeInvId],
    );
    expect(existing.rows[0]?.status).toBe('pending');
    expect(existing.rows[0]?.role).toBe('viewer');
  });

  it('RULING 22: workspace_email_has_active_member returns true for active member (any case), false for suspended or stranger', async () => {
    // 1. Active member with exact case
    const res1 = await asSubject(ownerA, async (client) => {
      const r = await client.query<{ res: boolean }>(
        'select public.workspace_email_has_active_member($1::uuid, $2::text) as res',
        [wsSharedId, 'active-member@example.test'],
      );
      return r.rows[0]?.res;
    });
    expect(res1).toBe(true);

    // 2. Active member with UPPERCASE / mixed case
    const res2 = await asSubject(ownerA, async (client) => {
      const r = await client.query<{ res: boolean }>(
        'select public.workspace_email_has_active_member($1::uuid, $2::text) as res',
        [wsSharedId, 'ACTIVE-MEMBER@EXAMPLE.TEST'],
      );
      return r.rows[0]?.res;
    });
    expect(res2).toBe(true);

    // 3. Suspended member
    const res3 = await asSubject(ownerA, async (client) => {
      const r = await client.query<{ res: boolean }>(
        'select public.workspace_email_has_active_member($1::uuid, $2::text) as res',
        [wsSharedId, 'suspended-member@example.test'],
      );
      return r.rows[0]?.res;
    });
    expect(res3).toBe(false);

    // 4. Stranger
    const res4 = await asSubject(ownerA, async (client) => {
      const r = await client.query<{ res: boolean }>(
        'select public.workspace_email_has_active_member($1::uuid, $2::text) as res',
        [wsSharedId, 'stranger@example.test'],
      );
      return r.rows[0]?.res;
    });
    expect(res4).toBe(false);
  });

  it('RULING 24: column-scoped INSERT grant refuses a forged id, status, or created_at', async () => {
    // Trying to insert with forged id
    await asSubject(ownerA, async (client) => {
      await expect(
        client.query(
          `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, expires_at)
           values ('00000000-0000-0000-0000-000000000999', $1, $2, 'forged-id@example.test', 'editor', now() + interval '7 days')`,
          [wsSharedId, ownerA],
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    // Trying to insert with forged status
    await asSubject(ownerA, async (client) => {
      await expect(
        client.query(
          `insert into public.workspace_invitations (workspace_id, invited_by, email, role, status, expires_at)
           values ($1, $2, 'forged-status@example.test', 'editor', 'accepted', now() + interval '7 days')`,
          [wsSharedId, ownerA],
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    // Trying to insert with forged created_at
    await asSubject(ownerA, async (client) => {
      await expect(
        client.query(
          `insert into public.workspace_invitations (workspace_id, invited_by, email, role, created_at, expires_at)
           values ($1, $2, 'forged-created@example.test', 'editor', now() - interval '10 days', now() + interval '7 days')`,
          [wsSharedId, ownerA],
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('RULING 25: email inserted as Foo@Example.COM is stored byte-identically and collides with lowercase on index', async () => {
    const mixedEmail = 'Foo@Example.COM';
    const outcome = await service.createWorkspaceInvitation(
      ownerA,
      wsSharedId,
      { email: mixedEmail, role: 'viewer' },
      '00000000-0000-0000-0000-000000000125',
    );
    expect(outcome.kind).toBe(WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED);
    if (outcome.kind === WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED) {
      expect(outcome.invitation.email).toBe(mixedEmail);

      // Check byte-identical storage in database
      const row = await admin.query<{ email: string }>(
        `select email from public.workspace_invitations where id = $1`,
        [outcome.invitation.id],
      );
      expect(row.rows[0]?.email).toBe('Foo@Example.COM');

      // Check collision on lowercase
      const secondAttempt = await service.createWorkspaceInvitation(
        ownerA,
        wsSharedId,
        { email: 'foo@example.com', role: 'editor' },
        '00000000-0000-0000-0000-000000000225',
      );
      expect(secondAttempt.kind).toBe(
        WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING,
      );
    }
  });

  it('A3 / RULING 27: concurrent-create race between TWO DIFFERENT SUBJECTS handles unique_violation and leaves exactly one pending row', async () => {
    const raceEmail = 'race-condition@example.test';
    const expiredRaceId = '00000000-0000-0000-0000-000000000127';

    // Seed expired pending invitation
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at, created_at)
       values ($1, $2, $3, $4, 'viewer', 'pending', now() - interval '1 hour', now() - interval '8 days')`,
      [expiredRaceId, wsSharedId, ownerA, raceEmail],
    );

    // Drive two requests concurrently using TWO DIFFERENT SUBJECTS (ownerA and adminB)
    // Because lock keys differ, transactions genuinely overlap
    const [res1, res2] = await Promise.all([
      service.createWorkspaceInvitation(
        ownerA,
        wsSharedId,
        { email: raceEmail, role: 'editor' },
        '00000000-0000-0000-0000-000000000227',
      ),
      service.createWorkspaceInvitation(
        adminB,
        wsSharedId,
        { email: raceEmail, role: 'viewer' },
        '00000000-0000-0000-0000-000000000327',
      ),
    ]);

    const kinds = [res1.kind, res2.kind].sort();
    // Exactly one created (201) and one already-pending (409)
    expect(kinds).toEqual([
      WORKSPACE_INVITATION_CREATE_OUTCOMES.ALREADY_PENDING,
      WORKSPACE_INVITATION_CREATE_OUTCOMES.CREATED,
    ]);

    // Exactly one pending row exists in database
    const pendingCount = await admin.query<{ count: string }>(
      `select count(*)::text as count
         from public.workspace_invitations
        where workspace_id = $1 and lower(email) = lower($2) and status = 'pending'`,
      [wsSharedId, raceEmail],
    );
    expect(pendingCount.rows[0]?.count).toBe('1');
  });

  it('A3 / RULING 27: isPendingEmailUniqueViolation distinguishes real pending index violation from real pkey violation', async () => {
    // 1. Provoke a genuine primary key violation via admin pool
    const pkeyId = '00000000-0000-0000-0000-000000000777';
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at)
       values ($1, $2, $3, 'unique-1@example.test', 'editor', 'pending', now() + interval '7 days')`,
      [pkeyId, wsSharedId, ownerA],
    );

    let realPkeyError: unknown;
    try {
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at)
         values ($1, $2, $3, 'unique-2@example.test', 'editor', 'pending', now() + interval '7 days')`,
        [pkeyId, wsSharedId, ownerA],
      );
    } catch (err) {
      realPkeyError = err;
    }

    expect(realPkeyError).toBeDefined();
    expect(isPendingEmailUniqueViolation(realPkeyError)).toBe(false);

    // 2. Provoke a genuine pending index violation via admin pool
    let realPendingIndexError: unknown;
    try {
      await admin.query(
        `insert into public.workspace_invitations (workspace_id, invited_by, email, role, status, expires_at)
         values ($1, $2, 'unique-1@example.test', 'viewer', 'pending', now() + interval '7 days')`,
        [wsSharedId, ownerA],
      );
    } catch (err) {
      realPendingIndexError = err;
    }

    expect(realPendingIndexError).toBeDefined();
    expect(isPendingEmailUniqueViolation(realPendingIndexError)).toBe(true);
  });

  it('B2: pagination round-trip pages through seeded invitations without dropping or duplicating rows', async () => {
    const pagedEmails = [
      'page-alpha@example.test',
      'page-beta@example.test',
      'page-gamma@example.test',
    ];

    // Seed 3 invitations in dedicated pagination workspace
    // Beta and Gamma share the same created_at timestamp to test ID tiebreak
    await admin.query(
      `delete from public.workspace_invitations where workspace_id = $1`,
      [wsPaginationId],
    );
    await admin.query(
      `insert into public.workspace_invitations (id, workspace_id, invited_by, email, role, status, expires_at, created_at)
       values ($1, $2, $3, $4, 'editor', 'pending', now() + interval '7 days', now() + interval '10 seconds'),
              ($5, $2, $3, $6, 'editor', 'pending', now() + interval '7 days', now() + interval '5 seconds'),
              ($7, $2, $3, $8, 'editor', 'pending', now() + interval '7 days', now() + interval '5 seconds')`,
      [
        '00000000-0000-0000-0000-000000000781',
        wsPaginationId,
        ownerA,
        pagedEmails[0],
        '00000000-0000-0000-0000-000000000782',
        pagedEmails[1],
        '00000000-0000-0000-0000-000000000783',
        pagedEmails[2],
      ],
    );

    // Page 1: limit 1
    const page1Outcome = await service.listWorkspaceInvitations(
      ownerA,
      wsPaginationId,
      { limit: 1 },
    );
    expect(page1Outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.OK);
    if (page1Outcome.kind !== WORKSPACE_INVITATION_LIST_OUTCOMES.OK) return;
    expect(page1Outcome.page.items.length).toBe(1);
    expect(page1Outcome.page.pageInfo.hasNextPage).toBe(true);
    expect(page1Outcome.page.pageInfo.nextCursor).not.toBeNull();

    // Page 2: limit 1 with cursor
    const cursor1 = decodeCursor(page1Outcome.page.pageInfo.nextCursor!);
    const page2Outcome = await service.listWorkspaceInvitations(
      ownerA,
      wsPaginationId,
      { cursor: cursor1, limit: 1 },
    );
    expect(page2Outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.OK);
    if (page2Outcome.kind !== WORKSPACE_INVITATION_LIST_OUTCOMES.OK) return;
    expect(page2Outcome.page.items.length).toBe(1);
    expect(page2Outcome.page.pageInfo.hasNextPage).toBe(true);
    expect(page2Outcome.page.pageInfo.nextCursor).not.toBeNull();

    // Page 3: limit 1 with cursor
    const cursor2 = decodeCursor(page2Outcome.page.pageInfo.nextCursor!);
    const page3Outcome = await service.listWorkspaceInvitations(
      ownerA,
      wsPaginationId,
      { cursor: cursor2, limit: 1 },
    );

    expect(page3Outcome.kind).toBe(WORKSPACE_INVITATION_LIST_OUTCOMES.OK);
    if (page3Outcome.kind !== WORKSPACE_INVITATION_LIST_OUTCOMES.OK) return;
    expect(page3Outcome.page.items.length).toBe(1);
    expect(page3Outcome.page.pageInfo.hasNextPage).toBe(false);
    expect(page3Outcome.page.pageInfo.nextCursor).toBeNull();

    const receivedEmails = [
      page1Outcome.page.items[0]?.email,
      page2Outcome.page.items[0]?.email,
      page3Outcome.page.items[0]?.email,
    ];
    // Assert all 3 seeded emails are present, no duplicates, no dropped rows
    for (const email of pagedEmails) {
      expect(receivedEmails).toContain(email);
    }
    expect(new Set(receivedEmails).size).toBe(3);
  });
});
