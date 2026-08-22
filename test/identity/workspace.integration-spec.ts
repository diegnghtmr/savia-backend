import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgTransaction } from '../../src/identity/pg-transaction.js';
import { PostgresWorkspaceAdapter } from '../../src/identity/postgres-workspace.adapter.js';
import { PostgresConfig } from '../../src/identity/postgres-config.js';
import { PostgresPool } from '../../src/identity/postgres-pool.js';
import { decodeCursor } from '../../src/identity/workspace.port.js';
import { WorkspaceService } from '../../src/identity/workspace.service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('WorkspaceService and PostgresWorkspaceAdapter database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresWorkspaceAdapter();
  let service: WorkspaceService;

  const subjectOwner = subject(700);
  const subjectEditor = subject(701);
  const subjectSuspended = subject(702);
  const subjectNonMember = subject(703);
  const subjectAdmin = subject(704);
  const subjectPaginator = subject(710);
  const subjectExactFull = subject(711);

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

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new WorkspaceService(transaction, adapter);

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12), ($13, $14)`,
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
      const isolatedStore: typeof adapter = {
        readMembership: async () => undefined,
        readWorkspace: (...args) => adapter.readWorkspace(...args),
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        update: (...args) => adapter.update(...args),
      };
      const isolatedService = new WorkspaceService(transaction, isolatedStore);
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
      const absentWorkspaceStore: typeof adapter = {
        readMembership: async () => ({
          role: 'owner',
          status: 'active',
        }),
        readWorkspace: async () => undefined,
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        update: (...args) => adapter.update(...args),
      };
      const absentWorkspaceService = new WorkspaceService(
        transaction,
        absentWorkspaceStore,
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
      const mockStore: typeof adapter = {
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
        update: async () => undefined, // simulates rowCount === 0 from concurrent bump
      };
      const concurrentService = new WorkspaceService(transaction, mockStore);
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

      const hookedStore: typeof adapter = {
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
        update: (...args) => adapter.update(...args),
      };

      const realConcurrentService = new WorkspaceService(
        transaction,
        hookedStore,
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

      const revokedStore: typeof adapter = {
        readMembership: (...args) => adapter.readMembership(...args),
        readWorkspace: (...args) => adapter.readWorkspace(...args),
        listWorkspaces: (...args) => adapter.listWorkspaces(...args),
        update: async (client, id, cmd, expected) => {
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
          }
        },
      };

      const revokedService = new WorkspaceService(transaction, revokedStore);
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
});
