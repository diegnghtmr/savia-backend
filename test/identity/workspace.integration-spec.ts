import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresWorkspaceAdapter } from '../../src/identity/postgres-workspace.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/identity/postgres-idempotency.adapter.js';
import { IDEMPOTENCY_OUTCOME_KINDS } from '../../src/identity/idempotency.port.js';
import { IdempotencyService } from '../../src/identity/idempotency.service.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';
import type { WorkspaceCreateCommand } from '../../src/identity/workspace-command.js';
import {
  decodeCursor,
  WORKSPACE_CREATE_OUTCOME_KINDS,
} from '../../src/identity/workspace.port.js';
import {
  WorkspaceService,
  type WorkspaceStore,
} from '../../src/identity/workspace.service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('WorkspaceService and PostgresWorkspaceAdapter database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresWorkspaceAdapter();
  const idempotencyAdapter = new PostgresIdempotencyAdapter();
  let idempotencyService: IdempotencyService;
  let service: WorkspaceService;

  const subjectOwner = subject(700);
  const subjectEditor = subject(701);
  const subjectSuspended = subject(702);
  const subjectNonMember = subject(703);
  const subjectAdmin = subject(704);
  const subjectPaginator = subject(710);
  const subjectExactFull = subject(711);
  const subjectCreator = subject(720);
  const subjectCreator2 = subject(721);
  const subjectMicroseconds = subject(730);

  const sharedWorkspaceId = '00000000-0000-0000-0000-000000000750';
  const ws1Id = '00000000-0000-0000-0000-000000000801';
  const ws2Id = '00000000-0000-0000-0000-000000000802';
  const ws3Id = '00000000-0000-0000-0000-000000000803';
  const ws4Id = '00000000-0000-0000-0000-000000000804';
  const ws5Id = '00000000-0000-0000-0000-000000000805';
  const ws6Id = '00000000-0000-0000-0000-000000000806';

  const exactFull1Id = '00000000-0000-0000-0000-000000000851';
  const exactFull2Id = '00000000-0000-0000-0000-000000000852';
  const exactFull3Id = '00000000-0000-0000-0000-000000000853';
  const exactFull4Id = '00000000-0000-0000-0000-000000000854';

  const wsMicro1Id = '00000000-0000-0000-0000-000000000871';
  const wsMicro2Id = '00000000-0000-0000-0000-000000000872';
  const wsMicro3Id = '00000000-0000-0000-0000-000000000873';
  const wsMicro4Id = '00000000-0000-0000-0000-000000000874';
  const wsMicro5Id = '00000000-0000-0000-0000-000000000875';
  const wsMicro6Id = '00000000-0000-0000-0000-000000000876';

  const wsPersonalId = '00000000-0000-0000-0000-000000000860';
  const wsDeletePositiveId = '00000000-0000-0000-0000-000000000861';
  const wsDeleteConcurrentId = '00000000-0000-0000-0000-000000000862';
  const wsDeleteReplayId = '00000000-0000-0000-0000-000000000863';
  const wsDeleteRecordSurvivesId = '00000000-0000-0000-0000-000000000864';

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    idempotencyService = new IdempotencyService(
      transaction,
      idempotencyAdapter,
    );
    service = new WorkspaceService(transaction, adapter, idempotencyAdapter);

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12), ($13, $14), ($15, $16), ($17, $18), ($19, $20)`,
      [
        subjectOwner,
        'owner@example.test',
        subjectEditor,
        'editor@example.test',
        subjectSuspended,
        'suspended@example.test',
        subjectNonMember,
        'nonmember@example.test',
        subjectAdmin,
        'admin@example.test',
        subjectPaginator,
        'paginator@example.test',
        subjectExactFull,
        'exactfull@example.test',
        subjectCreator,
        'creator@example.test',
        subjectCreator2,
        'creator2@example.test',
        subjectMicroseconds,
        'microseconds@example.test',
      ],
    );

    for (const [id, email, name] of [
      [subjectOwner, 'owner@example.test', 'Owner User'],
      [subjectEditor, 'editor@example.test', 'Editor User'],
      [subjectSuspended, 'suspended@example.test', 'Suspended User'],
      [subjectNonMember, 'nonmember@example.test', 'Non Member User'],
      [subjectAdmin, 'admin@example.test', 'Admin User'],
      [subjectPaginator, 'paginator@example.test', 'Paginator User'],
      [subjectExactFull, 'exactfull@example.test', 'Exact Full User'],
      [subjectCreator, 'creator@example.test', 'Creator User'],
      [subjectCreator2, 'creator2@example.test', 'Creator User 2'],
      [subjectMicroseconds, 'microseconds@example.test', 'Microseconds User'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Acme Shared Workspace', 'shared', 'USD', null)`,
      [sharedWorkspaceId],
    );

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'editor', 'active'),
              ($1, $4, 'owner', 'suspended'),
              ($1, $5, 'administrator', 'active')`,
      [
        sharedWorkspaceId,
        subjectOwner,
        subjectEditor,
        subjectSuspended,
        subjectAdmin,
      ],
    );

    // Seed 6 workspaces for subjectPaginator (ws3Id and ws4Id share identical created_at)
    for (const [id, name, role, createdAt] of [
      [ws1Id, 'Workspace Alpha', 'owner', '2026-07-01 00:00:00+00'],
      [ws2Id, 'Workspace Beta', 'editor', '2026-07-02 00:00:00+00'],
      [ws3Id, 'Workspace Gamma', 'viewer', '2026-07-03 00:00:00+00'],
      [ws4Id, 'Workspace Delta', 'administrator', '2026-07-03 00:00:00+00'],
      [ws5Id, 'Workspace Epsilon', 'editor', '2026-07-05 00:00:00+00'],
      [ws6Id, 'Workspace Zeta', 'owner', '2026-07-06 00:00:00+00'],
    ]) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_at)
         values ($1, $2, 'shared', 'USD', null, $3::timestamptz)`,
        [id, name, createdAt],
      );
      await admin.query(
        `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'active')`,
        [id, subjectPaginator, role],
      );
    }

    // Seed 4 workspaces for subjectExactFull (page size 2 -> 2 pages of exactly 2 items)
    for (const [id, name, role, createdAt] of [
      [exactFull1Id, 'Full 1', 'owner', '2026-07-10 00:00:00+00'],
      [exactFull2Id, 'Full 2', 'editor', '2026-07-11 00:00:00+00'],
      [exactFull3Id, 'Full 3', 'viewer', '2026-07-12 00:00:00+00'],
      [exactFull4Id, 'Full 4', 'administrator', '2026-07-13 00:00:00+00'],
    ]) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_at)
         values ($1, $2, 'shared', 'USD', null, $3::timestamptz)`,
        [id, name, createdAt],
      );
      await admin.query(
        `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'active')`,
        [id, subjectExactFull, role],
      );
    }

    // Seed 6 workspaces for subjectMicroseconds whose created_at differ only in microseconds,
    // with 4 sharing the .123 millisecond bucket and 2 sharing the .456 millisecond bucket.
    for (const [id, name, role, createdAt] of [
      [wsMicro1Id, 'Micro 1', 'owner', '2026-07-20 12:00:00.123450+00'],
      [wsMicro2Id, 'Micro 2', 'editor', '2026-07-20 12:00:00.123456+00'],
      [wsMicro3Id, 'Micro 3', 'viewer', '2026-07-20 12:00:00.123789+00'],
      [wsMicro4Id, 'Micro 4', 'administrator', '2026-07-20 12:00:00.123999+00'],
      [wsMicro5Id, 'Micro 5', 'editor', '2026-07-20 12:00:00.456100+00'],
      [wsMicro6Id, 'Micro 6', 'owner', '2026-07-20 12:00:00.456200+00'],
    ]) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_at)
         values ($1, $2, 'shared', 'USD', null, $3::timestamptz)`,
        [id, name, createdAt],
      );
      await admin.query(
        `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'active')`,
        [id, subjectMicroseconds, role],
      );
    }

    // Seed wsPersonalId for subjectOwner (personal workspace with deferred owner membership)
    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Personal Workspace Owner', 'personal', 'USD', $2)`,
      [wsPersonalId, subjectOwner],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsPersonalId, subjectOwner],
    );
    await admin.query('commit');

    // Seed wsDeletePositiveId for subjectOwner (shared workspace for positive control deletion)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Delete Positive Control WS', 'shared', 'USD', null)`,
      [wsDeletePositiveId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsDeletePositiveId, subjectOwner],
    );

    // Seed wsDeleteConcurrentId for subjectOwner (shared workspace for concurrent deletion test)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Delete Concurrent WS', 'shared', 'USD', null)`,
      [wsDeleteConcurrentId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsDeleteConcurrentId, subjectOwner],
    );

    // Seed wsDeleteReplayId for subjectOwner (shared workspace for idempotency replay test)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Delete Replay WS', 'shared', 'USD', null)`,
      [wsDeleteReplayId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsDeleteReplayId, subjectOwner],
    );

    // Seed wsDeleteRecordSurvivesId for subjectOwner (shared workspace proving the
    // idempotency record outlives the workspace whose deletion it records)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Delete Record Survives WS', 'shared', 'USD', null)`,
      [wsDeleteRecordSurvivesId],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsDeleteRecordSurvivesId, subjectOwner],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('an active member reads the workspace and gets the seven fields with the right role', async () => {
    const outcome = await service.read(subjectOwner, sharedWorkspaceId);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    expect(outcome.workspace).toEqual({
      id: sharedWorkspaceId,
      name: 'Acme Shared Workspace',
      kind: 'shared',
      baseCurrency: 'USD',
      role: 'owner',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      version: 1,
    });
    expect(Object.keys(outcome.workspace).sort()).toEqual(
      [
        'id',
        'name',
        'kind',
        'baseCurrency',
        'role',
        'createdAt',
        'version',
      ].sort(),
    );
  });

  it("role is the caller's own role, not another member's", async () => {
    const ownerOutcome = await service.read(subjectOwner, sharedWorkspaceId);
    expect(ownerOutcome.kind).toBe('ok');
    if (ownerOutcome.kind === 'ok') {
      expect(ownerOutcome.workspace.role).toBe('owner');
    }

    const editorOutcome = await service.read(subjectEditor, sharedWorkspaceId);
    expect(editorOutcome.kind).toBe('ok');
    if (editorOutcome.kind === 'ok') {
      expect(editorOutcome.workspace.role).toBe('editor');
    }
  });

  it('a suspended member gets 403 (forbidden) from the service (202607150006_workspace_active_membership.sql)', async () => {
    const outcome = await service.read(subjectSuspended, sharedWorkspaceId);
    expect(outcome.kind).toBe('forbidden');
  });

  it('hardened RLS policy returns zero rows for a suspended member selecting from public.workspaces (202607150006_workspace_active_membership.sql)', async () => {
    const result = await transaction.runRead(subjectSuspended, (client) =>
      client.query<{ id: string }>(
        'select id from public.workspaces where id = $1',
        [sharedWorkspaceId],
      ),
    );
    expect(result.rows).toHaveLength(0);
  });

  it('a non-member gets 404 (not-found) from the service', async () => {
    const outcome = await service.read(subjectNonMember, sharedWorkspaceId);
    expect(outcome.kind).toBe('not-found');
  });

  it('a non-member selecting from public.workspaces returns zero rows under RLS', async () => {
    const result = await transaction.runRead(subjectNonMember, (client) =>
      client.query<{ id: string }>(
        'select id from public.workspaces where id = $1',
        [sharedWorkspaceId],
      ),
    );
    expect(result.rows).toHaveLength(0);
  });

  it('pages through 6 workspaces with limit=2 and asserts concatenation equals full expected set in order with no duplicates and no gaps', async () => {
    const page1 = await service.list(subjectPaginator, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    expect(page1.pageInfo.nextCursor).toBeTypeOf('string');

    const cursor1 = decodeCursor(page1.pageInfo.nextCursor!);
    expect(cursor1).toBeDefined();

    const page2 = await service.list(subjectPaginator, {
      cursor: cursor1,
      limit: 2,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.pageInfo.hasNextPage).toBe(true);
    expect(page2.pageInfo.nextCursor).toBeTypeOf('string');

    const cursor2 = decodeCursor(page2.pageInfo.nextCursor!);
    expect(cursor2).toBeDefined();

    const page3 = await service.list(subjectPaginator, {
      cursor: cursor2,
      limit: 2,
    });
    expect(page3.items).toHaveLength(2);
    expect(page3.pageInfo.hasNextPage).toBe(false);
    expect(page3.pageInfo.nextCursor).toBeNull();

    const allItems = [...page1.items, ...page2.items, ...page3.items];
    expect(allItems).toHaveLength(6);
    expect(allItems.map((w) => w.id)).toEqual([
      ws1Id,
      ws2Id,
      ws3Id,
      ws4Id,
      ws5Id,
      ws6Id,
    ]);
    expect(allItems.map((w) => w.role)).toEqual([
      'owner',
      'editor',
      'viewer',
      'administrator',
      'editor',
      'owner',
    ]);
    for (const item of allItems) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'name',
          'kind',
          'baseCurrency',
          'role',
          'createdAt',
          'version',
        ].sort(),
      );
    }
  });

  it('handles identical created_at boundary correctly using id tiebreak', async () => {
    // ws3Id and ws4Id share identical created_at '2026-07-03 00:00:00+00'
    const cursor = {
      createdAt: new Date('2026-07-03 00:00:00+00').toISOString(),
      id: ws3Id,
    };
    const result = await service.list(subjectPaginator, { cursor, limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(ws4Id);
    expect(result.items[0]?.name).toBe('Workspace Delta');
    expect(result.pageInfo.hasNextPage).toBe(true);
  });

  it('reports hasNextPage: false on a final page that is exactly full (limit+1 proof)', async () => {
    const page1 = await service.list(subjectExactFull, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    expect(page1.pageInfo.nextCursor).toBeTypeOf('string');

    const cursor1 = decodeCursor(page1.pageInfo.nextCursor!);
    expect(cursor1).toBeDefined();

    const page2 = await service.list(subjectExactFull, {
      cursor: cursor1,
      limit: 2,
    });
    expect(page2.items).toHaveLength(2);
    // Exactly full page (items.length === 2 === limit) must report hasNextPage: false
    expect(page2.pageInfo.hasNextPage).toBe(false);
    expect(page2.pageInfo.nextCursor).toBeNull();
  });

  it('pages through workspaces whose created_at differs only in microseconds without repeating or dropping items', async () => {
    const expectedIds = [
      wsMicro1Id,
      wsMicro2Id,
      wsMicro3Id,
      wsMicro4Id,
      wsMicro5Id,
      wsMicro6Id,
    ];
    const walkedIds: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = undefined;

    for (let i = 0; i < expectedIds.length; i++) {
      const page = await service.list(subjectMicroseconds, {
        cursor,
        limit: 1,
      });
      expect(page.items).toHaveLength(1);
      const item = page.items[0]!;
      walkedIds.push(item.id);

      if (i < expectedIds.length - 1) {
        expect(page.pageInfo.hasNextPage).toBe(true);
        expect(page.pageInfo.nextCursor).toBeTypeOf('string');
        cursor = decodeCursor(page.pageInfo.nextCursor!);
        expect(cursor).toBeDefined();
      } else {
        expect(page.pageInfo.hasNextPage).toBe(false);
        expect(page.pageInfo.nextCursor).toBeNull();
      }
    }

    expect(walkedIds).toEqual(expectedIds);
    expect(new Set(walkedIds).size).toBe(walkedIds.length);
  });

  it("a suspended member's workspace does not appear in their list", async () => {
    const outcome = await service.list(subjectSuspended, { limit: 50 });
    expect(outcome.items).toHaveLength(0);
    expect(outcome.pageInfo.hasNextPage).toBe(false);
    expect(outcome.pageInfo.nextCursor).toBeNull();
  });

  describe('update', () => {
    it('returns not-found when caller is not a member of the workspace and asserts nothing was persisted', async () => {
      const readBefore = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readBefore.kind).toBe('ok');
      if (readBefore.kind !== 'ok') throw new Error('unreachable');

      // Create a store where workspace IS readable (returns row) but membership is absent (undefined),
      // isolating the membership === undefined branch.
      const isolatedStore: WorkspaceStore = {
        readMembership: async () => undefined,
        readWorkspace: (...args) => adapter.readWorkspace(...args),
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        createWorkspace: (...args) => adapter.createWorkspace(...args),
        createMembership: (...args) => adapter.createMembership(...args),
        update: (...args) => adapter.update(...args),
        deleteWorkspace: (...args) => adapter.deleteWorkspace(...args),
      };
      const isolatedService = new WorkspaceService(
        transaction,
        isolatedStore,
        idempotencyAdapter,
      );
      const outcome = await isolatedService.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Hacked Workspace' },
        undefined,
      );
      expect(outcome.kind).toBe('not-found');

      const readAfter = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readAfter.kind).toBe('ok');
      if (readAfter.kind !== 'ok') throw new Error('unreachable');
      expect(readAfter.workspace.name).toBe(readBefore.workspace.name);
    });

    it('returns forbidden when caller is a suspended member with positive control for active owner and asserts no write occurred', async () => {
      const readBefore = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readBefore.kind).toBe('ok');
      if (readBefore.kind !== 'ok') throw new Error('unreachable');

      const outcome = await service.update(
        subjectSuspended,
        sharedWorkspaceId,
        { name: 'Suspended Attempt' },
        undefined,
      );
      expect(outcome.kind).toBe('forbidden');

      // Prove no write occurred
      const readAfterSuspended = await service.read(
        subjectOwner,
        sharedWorkspaceId,
      );
      expect(readAfterSuspended.kind).toBe('ok');
      if (readAfterSuspended.kind !== 'ok') throw new Error('unreachable');
      expect(readAfterSuspended.workspace.name).toBe(readBefore.workspace.name);

      // Positive control: active owner issues identical request and succeeds (200)
      const positiveOutcome = await service.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Owner Active Name' },
        undefined,
      );
      expect(positiveOutcome.kind).toBe('ok');
    });

    it('returns forbidden when caller is an active editor with positive control for active administrator', async () => {
      const outcome = await service.update(
        subjectEditor,
        sharedWorkspaceId,
        { name: 'Editor Attempt' },
        undefined,
      );
      expect(outcome.kind).toBe('forbidden');

      // Positive control: active administrator issues identical request and succeeds (200)
      const positiveOutcome = await service.update(
        subjectAdmin,
        sharedWorkspaceId,
        { name: 'Admin Positive Control' },
        undefined,
      );
      expect(positiveOutcome.kind).toBe('ok');
    });

    it('returns not-found when active owner attempts to update an absent workspace row', async () => {
      // Store where caller has an active owner membership, but workspace row is absent,
      // isolating the workspace === undefined branch.
      const absentWorkspaceStore: WorkspaceStore = {
        readMembership: async () => ({
          role: 'owner',
          status: 'active',
        }),
        readWorkspace: async () => undefined,
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        createWorkspace: (...args) => adapter.createWorkspace(...args),
        createMembership: (...args) => adapter.createMembership(...args),
        update: (...args) => adapter.update(...args),
        deleteWorkspace: (...args) => adapter.deleteWorkspace(...args),
      };
      const absentWorkspaceService = new WorkspaceService(
        transaction,
        absentWorkspaceStore,
        idempotencyAdapter,
      );
      const outcome = await absentWorkspaceService.update(
        subjectOwner,
        '00000000-0000-0000-0000-000000000999',
        { name: 'Non Existent' },
        undefined,
      );
      expect(outcome.kind).toBe('not-found');
    });

    it('returns version-conflict when If-Match version is stale against read version and does not persist', async () => {
      const readBefore = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readBefore.kind).toBe('ok');
      if (readBefore.kind !== 'ok') throw new Error('unreachable');

      const staleVersion = readBefore.workspace.version + 999;
      const outcome = await service.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Stale Version Attempt' },
        staleVersion,
      );
      expect(outcome.kind).toBe('version-conflict');

      const readAfter = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readAfter.kind).toBe('ok');
      if (readAfter.kind !== 'ok') throw new Error('unreachable');
      expect(readAfter.workspace.name).toBe(readBefore.workspace.name);
    });

    it('active owner updates workspace successfully, version increments by 1, and returns updated workspace', async () => {
      const readBefore = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readBefore.kind).toBe('ok');
      if (readBefore.kind !== 'ok') throw new Error('unreachable');

      const outcome = await service.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Acme Super Shared', baseCurrency: 'EUR' },
        readBefore.workspace.version,
      );

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') throw new Error('unreachable');
      expect(outcome.version).toBe(readBefore.workspace.version + 1);
      expect(outcome.workspace.version).toBe(readBefore.workspace.version + 1);
      expect(outcome.workspace.name).toBe('Acme Super Shared');
      expect(outcome.workspace.baseCurrency).toBe('EUR');
      expect(outcome.workspace.role).toBe('owner');
    });

    it('covers service mapping only: returns version-conflict when store.update returns undefined and re-read version differs', async () => {
      const mockStore: WorkspaceStore = {
        readMembership: (...args) => adapter.readMembership(...args),
        readWorkspace: vi
          .fn()
          .mockImplementationOnce((client, id) =>
            adapter.readWorkspace(client, id),
          )
          .mockImplementationOnce(async (client, id) => {
            const row = await adapter.readWorkspace(client, id);
            return row ? { ...row, version: row.version + 1 } : undefined;
          }),
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        createWorkspace: (...args) => adapter.createWorkspace(...args),
        createMembership: (...args) => adapter.createMembership(...args),
        update: async () => undefined, // simulates rowCount === 0 from concurrent bump
        deleteWorkspace: (...args) => adapter.deleteWorkspace(...args),
      };
      const concurrentService = new WorkspaceService(
        transaction,
        mockStore,
        idempotencyAdapter,
      );
      const outcome = await concurrentService.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Acme Concurrently Bumped Mock' },
        undefined,
      );
      expect(outcome.kind).toBe('version-conflict');
    });

    it('returns version-conflict and leaves name intact when concurrent transaction bumps version between read and write in real database', async () => {
      const readBefore = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readBefore.kind).toBe('ok');
      if (readBefore.kind !== 'ok') throw new Error('unreachable');

      const hookedStore: WorkspaceStore = {
        readMembership: (...args) => adapter.readMembership(...args),
        readWorkspace: async (client, id) => {
          const ws = await adapter.readWorkspace(client, id);
          await admin.query(
            'update public.workspaces set version = version + 1 where id = $1',
            [id],
          );
          return ws;
        },
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        createWorkspace: (...args) => adapter.createWorkspace(...args),
        createMembership: (...args) => adapter.createMembership(...args),
        update: (...args) => adapter.update(...args),
        deleteWorkspace: (...args) => adapter.deleteWorkspace(...args),
      };

      const realConcurrentService = new WorkspaceService(
        transaction,
        hookedStore,
        idempotencyAdapter,
      );
      const outcome = await realConcurrentService.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Concurrent Database Bump Attempt' },
        readBefore.workspace.version,
      );

      expect(outcome.kind).toBe('version-conflict');

      const readAfter = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readAfter.kind).toBe('ok');
      if (readAfter.kind !== 'ok') throw new Error('unreachable');
      expect(readAfter.workspace.name).toBe(readBefore.workspace.name);
    });

    it('returns forbidden and does not persist when caller authorization is revoked mid-transaction before update', async () => {
      const readBefore = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readBefore.kind).toBe('ok');
      if (readBefore.kind !== 'ok') throw new Error('unreachable');

      const revokedStore: WorkspaceStore = {
        readMembership: (...args) => adapter.readMembership(...args),
        readWorkspace: (...args) => adapter.readWorkspace(...args),
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        createWorkspace: (...args) => adapter.createWorkspace(...args),
        createMembership: (...args) => adapter.createMembership(...args),
        deleteWorkspace: (...args) => adapter.deleteWorkspace(...args),
        update: async (client, id, cmd, expected) => {
          await admin.query(
            "update public.workspace_memberships set role = 'owner' where workspace_id = $1 and profile_id = $2",
            [id, subjectAdmin],
          );
          await admin.query(
            "update public.workspace_memberships set role = 'viewer' where workspace_id = $1 and profile_id = $2",
            [id, subjectOwner],
          );
          try {
            return await adapter.update(client, id, cmd, expected);
          } finally {
            await admin.query(
              "update public.workspace_memberships set role = 'owner' where workspace_id = $1 and profile_id = $2",
              [id, subjectOwner],
            );
            await admin.query(
              "update public.workspace_memberships set role = 'administrator' where workspace_id = $1 and profile_id = $2",
              [id, subjectAdmin],
            );
          }
        },
      };

      const revokedService = new WorkspaceService(
        transaction,
        revokedStore,
        idempotencyAdapter,
      );
      const outcome = await revokedService.update(
        subjectOwner,
        sharedWorkspaceId,
        { name: 'Revocation Attempt' },
        readBefore.workspace.version,
      );

      expect(outcome.kind).toBe('forbidden');

      const readAfter = await service.read(subjectOwner, sharedWorkspaceId);
      expect(readAfter.kind).toBe('ok');
      if (readAfter.kind !== 'ok') throw new Error('unreachable');
      expect(readAfter.workspace.name).toBe(readBefore.workspace.name);
    });
  });

  describe('WorkspaceService.create', () => {
    it('an active creator creates a collaborative workspace stamping created_by and owner membership', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c01';
      const command: WorkspaceCreateCommand = {
        name: 'Created Family Workspace',
        kind: 'family',
        baseCurrency: 'USD',
      };

      const outcome = await service.create(subjectCreator, command, key);
      expect(outcome.kind).toBe(WORKSPACE_CREATE_OUTCOME_KINDS.CREATED);
      if (outcome.kind !== WORKSPACE_CREATE_OUTCOME_KINDS.CREATED) return;

      expect(outcome.workspace).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: 'Created Family Workspace',
        kind: 'family',
        baseCurrency: 'USD',
        role: 'owner',
        createdAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        ),
        version: 1,
      });

      // Verify directly in database under elevated connection
      const wsResult = await admin.query<{
        created_by: string;
        name: string;
        kind: string;
        base_currency: string;
        version: number;
      }>(
        'select created_by, name, kind, base_currency, version from public.workspaces where id = $1',
        [outcome.workspace.id],
      );
      expect(wsResult.rows).toHaveLength(1);
      expect(wsResult.rows[0]?.created_by).toBe(subjectCreator);
      expect(wsResult.rows[0]?.name).toBe('Created Family Workspace');
      expect(wsResult.rows[0]?.kind).toBe('family');
      expect(wsResult.rows[0]?.base_currency).toBe('USD');
      expect(wsResult.rows[0]?.version).toBe(1);

      const memResult = await admin.query<{ role: string; status: string }>(
        'select role, status from public.workspace_memberships where workspace_id = $1 and profile_id = $2',
        [outcome.workspace.id, subjectCreator],
      );
      expect(memResult.rows).toHaveLength(1);
      expect(memResult.rows[0]?.role).toBe('owner');
      expect(memResult.rows[0]?.status).toBe('active');
    });

    it('atomicity: rolled back transaction leaves 0 orphaned workspace rows when membership fails after workspace insert', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c02';
      const command: WorkspaceCreateCommand = {
        name: 'Atomicity Rolled Back Workspace',
        kind: 'shared',
        baseCurrency: 'USD',
      };

      let insertedWorkspaceId: string | undefined;
      const failingStore: WorkspaceStore = {
        readMembership: adapter.readMembership.bind(adapter),
        readWorkspace: adapter.readWorkspace.bind(adapter),
        listWorkspaces: adapter.listWorkspaces.bind(adapter),
        update: adapter.update.bind(adapter),
        deleteWorkspace: adapter.deleteWorkspace.bind(adapter),
        createWorkspace: async (client, sub, cmd) => {
          const record = await adapter.createWorkspace(client, sub, cmd);
          insertedWorkspaceId = record.id;
          return record;
        },
        createMembership: async () => {
          throw new Error('Simulated membership insert failure');
        },
      };

      const failingService = new WorkspaceService(
        transaction,
        failingStore,
        idempotencyAdapter,
      );

      await expect(
        failingService.create(subjectCreator, command, key),
      ).rejects.toThrow('Simulated membership insert failure');

      expect(insertedWorkspaceId).toBeDefined();

      // Assert count(*) = 0 for that workspace ID
      const countResult = await admin.query<{ count: string }>(
        'select count(*) as count from public.workspaces where id = $1',
        [insertedWorkspaceId],
      );
      expect(countResult.rows[0]?.count).toBe('0');

      // Assert no idempotency record was committed
      const idempResult = await admin.query<{ count: string }>(
        'select count(*) as count from public.command_idempotency_records where idempotency_key = $1',
        [key],
      );
      expect(idempResult.rows[0]?.count).toBe('0');
    });

    it('identical replay returns the stored outcome without inserting a second workspace', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c03';
      const command: WorkspaceCreateCommand = {
        name: 'Replay Workspace Testing',
        kind: 'family',
        baseCurrency: 'EUR',
      };

      const firstOutcome = await service.create(subjectCreator, command, key);
      expect(firstOutcome.kind).toBe(WORKSPACE_CREATE_OUTCOME_KINDS.CREATED);
      if (firstOutcome.kind !== WORKSPACE_CREATE_OUTCOME_KINDS.CREATED) return;

      const secondOutcome = await service.create(subjectCreator, command, key);
      expect(secondOutcome.kind).toBe(WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED);
      if (secondOutcome.kind !== WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED)
        return;

      expect(secondOutcome.status).toBe(201);
      expect(secondOutcome.etag).toBe(`"${firstOutcome.workspace.version}"`);
      expect(secondOutcome.body).toEqual(firstOutcome.workspace);

      // Assert workspace count in database stays 1
      const countResult = await admin.query<{ count: string }>(
        'select count(*) as count from public.workspaces where name = $1 and created_by = $2',
        ['Replay Workspace Testing', subjectCreator],
      );
      expect(countResult.rows[0]?.count).toBe('1');
    });

    it('same idempotency key with different payload returns idempotency conflict', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c04';
      const initialCommand: WorkspaceCreateCommand = {
        name: 'Initial Workspace',
        kind: 'family',
        baseCurrency: 'USD',
      };

      const firstOutcome = await service.create(
        subjectCreator,
        initialCommand,
        key,
      );
      expect(firstOutcome.kind).toBe(WORKSPACE_CREATE_OUTCOME_KINDS.CREATED);

      const mutatedCommand: WorkspaceCreateCommand = {
        name: 'Mutated Workspace Name',
        kind: 'family',
        baseCurrency: 'USD',
      };

      const conflictOutcome = await service.create(
        subjectCreator,
        mutatedCommand,
        key,
      );
      expect(conflictOutcome.kind).toBe(
        WORKSPACE_CREATE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT,
      );
    });

    it('same key on different route templates executes independently', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c05';
      const command: WorkspaceCreateCommand = {
        name: 'Route Isolation Workspace',
        kind: 'family',
        baseCurrency: 'USD',
      };

      const workspaceOutcome = await service.create(
        subjectCreator2,
        command,
        key,
      );
      expect(workspaceOutcome.kind).toBe(
        WORKSPACE_CREATE_OUTCOME_KINDS.CREATED,
      );

      // Execute another route template with same key
      let otherExecuted = false;
      const otherOutcome = await idempotencyService.execute(
        {
          subject: subjectCreator2,
          route: 'DELETE /v1/workspaces/{workspaceId}',
          idempotencyKey: key,
          payload: { workspaceId: '00000000-0000-0000-0000-000000000001' },
        },
        async () => {
          otherExecuted = true;
          return { status: 204, etag: null, body: null };
        },
      );

      expect(otherOutcome.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
      expect(otherExecuted).toBe(true);
    });
  });

  describe('WorkspaceService.delete', () => {
    it('Row A: caller is not a member of the workspace -> not-found (404) and asserts workspace is still present', async () => {
      const outcome = await service.delete(
        subjectNonMember,
        sharedWorkspaceId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d01',
      );
      expect(outcome.kind).toBe('not-found');

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [sharedWorkspaceId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('Row B: caller is a suspended member -> forbidden (403) and asserts workspace is still present', async () => {
      const outcome = await service.delete(
        subjectSuspended,
        sharedWorkspaceId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d02',
      );
      expect(outcome.kind).toBe('forbidden');

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [sharedWorkspaceId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('Row C: caller is an active editor (role != owner) -> forbidden (403) and asserts workspace is still present', async () => {
      const outcome = await service.delete(
        subjectEditor,
        sharedWorkspaceId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d03',
      );
      expect(outcome.kind).toBe('forbidden');

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [sharedWorkspaceId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('Row D: active owner attempts to delete an absent workspace -> not-found (404)', async () => {
      const outcome = await service.delete(
        subjectOwner,
        '00000000-0000-0000-0000-000000000999',
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d04',
      );
      expect(outcome.kind).toBe('not-found');
    });

    it('Row E: active owner attempts to delete personal workspace -> unprocessable (422) without issuing DELETE and asserts row is still present', async () => {
      let deleteCalled = false;
      const trackingStore: WorkspaceStore = {
        readMembership: adapter.readMembership.bind(adapter),
        readWorkspace: adapter.readWorkspace.bind(adapter),
        listWorkspaces: adapter.listWorkspaces.bind(adapter),
        createWorkspace: adapter.createWorkspace.bind(adapter),
        createMembership: adapter.createMembership.bind(adapter),
        update: adapter.update.bind(adapter),
        deleteWorkspace: async (client, id) => {
          deleteCalled = true;
          return adapter.deleteWorkspace(client, id);
        },
      };
      const trackingService = new WorkspaceService(
        transaction,
        trackingStore,
        idempotencyAdapter,
      );

      const outcome = await trackingService.delete(
        subjectOwner,
        wsPersonalId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d05',
      );
      expect(outcome.kind).toBe('unprocessable');
      expect(deleteCalled).toBe(false);

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsPersonalId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('Row F: active owner deletes shared workspace (positive control) -> deleted (204) and row is gone', async () => {
      const outcome = await service.delete(
        subjectOwner,
        wsDeletePositiveId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d06',
      );
      expect(outcome.kind).toBe('deleted');

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsDeletePositiveId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('Row G: active owner on personal workspace with service check bypassed -> RLS yields DELETE 0, confirming re-SELECT finds row present -> unprocessable (422) and row is still present', async () => {
      const bypassedStore: WorkspaceStore = {
        readMembership: adapter.readMembership.bind(adapter),
        readWorkspace: async (client, id) => {
          const row = await adapter.readWorkspace(client, id);
          if (row && row.kind === 'personal') {
            return { ...row, kind: 'shared' };
          }
          return row;
        },
        listWorkspaces: adapter.listWorkspaces.bind(adapter),
        createWorkspace: adapter.createWorkspace.bind(adapter),
        createMembership: adapter.createMembership.bind(adapter),
        update: adapter.update.bind(adapter),
        deleteWorkspace: adapter.deleteWorkspace.bind(adapter),
      };
      const bypassedService = new WorkspaceService(
        transaction,
        bypassedStore,
        idempotencyAdapter,
      );

      const outcome = await bypassedService.delete(
        subjectOwner,
        wsPersonalId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d07',
      );
      expect(outcome.kind).toBe('unprocessable');

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsPersonalId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('Row H: active owner on shared workspace concurrently deleted before DELETE -> DELETE 0, confirming re-SELECT finds row absent -> not-found (404)', async () => {
      const concurrentDeleteStore: WorkspaceStore = {
        readMembership: adapter.readMembership.bind(adapter),
        readWorkspace: adapter.readWorkspace.bind(adapter),
        listWorkspaces: adapter.listWorkspaces.bind(adapter),
        createWorkspace: adapter.createWorkspace.bind(adapter),
        createMembership: adapter.createMembership.bind(adapter),
        update: adapter.update.bind(adapter),
        deleteWorkspace: async (client, id) => {
          await admin.query('delete from public.workspaces where id = $1', [
            id,
          ]);
          return adapter.deleteWorkspace(client, id);
        },
      };
      const concurrentDeleteService = new WorkspaceService(
        transaction,
        concurrentDeleteStore,
        idempotencyAdapter,
      );

      const outcome = await concurrentDeleteService.delete(
        subjectOwner,
        wsDeleteConcurrentId,
        'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d08',
      );
      expect(outcome.kind).toBe('not-found');
    });

    it('identical replay after 204 returns replayed outcome without re-issuing DELETE', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d09';
      let deleteCount = 0;
      const countingStore: WorkspaceStore = {
        readMembership: adapter.readMembership.bind(adapter),
        readWorkspace: adapter.readWorkspace.bind(adapter),
        listWorkspaces: adapter.listWorkspaces.bind(adapter),
        createWorkspace: adapter.createWorkspace.bind(adapter),
        createMembership: adapter.createMembership.bind(adapter),
        update: adapter.update.bind(adapter),
        deleteWorkspace: async (client, id) => {
          deleteCount += 1;
          return adapter.deleteWorkspace(client, id);
        },
      };
      const countingService = new WorkspaceService(
        transaction,
        countingStore,
        idempotencyAdapter,
      );

      const firstOutcome = await countingService.delete(
        subjectOwner,
        wsDeleteReplayId,
        key,
      );
      expect(firstOutcome.kind).toBe('deleted');
      expect(deleteCount).toBe(1);

      const secondOutcome = await countingService.delete(
        subjectOwner,
        wsDeleteReplayId,
        key,
      );
      expect(secondOutcome.kind).toBe('replayed');
      if (secondOutcome.kind === 'replayed') {
        expect(secondOutcome.status).toBe(204);
      }
      expect(deleteCount).toBe(1);
    });

    it('identical replay after refusal (403/404/422) returns stored refusal outcome without re-executing', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d10';
      const firstOutcome = await service.delete(
        subjectEditor,
        sharedWorkspaceId,
        key,
      );
      expect(firstOutcome.kind).toBe('forbidden');

      const secondOutcome = await service.delete(
        subjectEditor,
        sharedWorkspaceId,
        key,
      );
      expect(secondOutcome.kind).toBe('replayed');
      if (secondOutcome.kind === 'replayed') {
        expect(secondOutcome.status).toBe(403);
      }
    });

    // Records are workspace-scoped: the wsPersonalId refusal occupies the
    // (subject, route, key, wsPersonalId) slot, so reusing the key against a
    // DIFFERENT workspace is a different command slot and must execute for real.
    it('same idempotency key on two different workspaces uses independent slots: stored refusal does not block the second delete', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d11';
      const firstOutcome = await service.delete(
        subjectOwner,
        wsPersonalId,
        key,
      );
      expect(firstOutcome.kind).toBe('unprocessable');

      const secondOutcome = await service.delete(
        subjectOwner,
        sharedWorkspaceId,
        key,
      );
      expect(secondOutcome.kind).toBe('deleted');
    });

    // RULING 47: workspace_id on command_idempotency_records is a scoping
    // discriminator, not a referential link -- it carries NO foreign key. This
    // service path deletes the workspaces row and THEN writes the record that
    // references its id inside ONE transaction; any FK here raises 23503 and
    // rolls the whole delete back, and reordering cannot help because cascade
    // would destroy the record that must answer the replay. The defect only
    // appears when a CALLER deletes the referenced row in-transaction, so this
    // test goes through the real WorkspaceService.delete(), never the adapter.
    it('delete succeeds through the real service path and the idempotency record outlives the deleted workspace', async () => {
      const key = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7d12';

      const outcome = await service.delete(
        subjectOwner,
        wsDeleteRecordSurvivesId,
        key,
      );
      expect(outcome.kind).toBe('deleted');

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsDeleteRecordSurvivesId],
      );
      expect(check.rows).toHaveLength(0);

      const records = await admin.query<{ count: string }>(
        `select count(*)::text as count
           from public.command_idempotency_records
          where subject_id = $1 and route = $2 and idempotency_key = $3 and workspace_id = $4`,
        [
          subjectOwner,
          'DELETE /v1/workspaces/{workspaceId}',
          key,
          wsDeleteRecordSurvivesId,
        ],
      );
      expect(records.rows[0]?.count).toBe('1');

      const replay = await service.delete(
        subjectOwner,
        wsDeleteRecordSurvivesId,
        key,
      );
      expect(replay.kind).toBe('replayed');
      if (replay.kind === 'replayed') {
        expect(replay.status).toBe(204);
      }
    });
  });
});
