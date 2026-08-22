// Migrations under test: 202607150013_workspace_member_roster.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTransaction } from '../../src/identity/pg-transaction.js';
import { PostgresConfig } from '../../src/identity/postgres-config.js';
import { PostgresPool } from '../../src/identity/postgres-pool.js';
import { PostgresWorkspaceMemberAdapter } from '../../src/identity/postgres-workspace-member.adapter.js';
import {
  decodeMemberCursor,
  type WorkspaceMember,
} from '../../src/identity/workspace-member.port.js';
import { WorkspaceMemberService } from '../../src/identity/workspace-member.service.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('Workspace member roster (202607150013_workspace_member_roster.sql)', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresWorkspaceMemberAdapter();
  let service: WorkspaceMemberService;

  const subjectOwner = subject(1001);
  const subjectAdmin = subject(1002);
  const subjectEditor = subject(1003);
  const subjectViewer = subject(1004);
  const subjectSuspended = subject(1005);
  const subjectNonMember = subject(1006);

  const workspaceW = '00000000-0000-0000-0000-000000001100';
  const workspaceOther = '00000000-0000-0000-0000-000000001101';

  const memOwnerId = '00000000-0000-0000-0000-000000001111';
  const memAdminId = '00000000-0000-0000-0000-000000001112';
  const memEditorId = '00000000-0000-0000-0000-000000001113';
  const memViewerId = '00000000-0000-0000-0000-000000001114';
  const memSuspendedId = '00000000-0000-0000-0000-000000001115';
  const memOtherId = '00000000-0000-0000-0000-000000001116';

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
    pool = new PostgresPool(new PostgresConfig(url));
    transaction = new PgTransaction(pool);
    service = new WorkspaceMemberService(transaction, adapter);

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10), ($11, $12)`,
      [
        subjectOwner,
        'owner@example.test',
        subjectAdmin,
        'admin@example.test',
        subjectEditor,
        'editor@example.test',
        subjectViewer,
        'viewer@example.test',
        subjectSuspended,
        'suspended@example.test',
        subjectNonMember,
        'nonmember@example.test',
      ],
    );

    for (const [id, email, name] of [
      [subjectOwner, 'owner@example.test', 'Owner User'],
      [subjectAdmin, 'admin@example.test', 'Admin User'],
      [subjectEditor, 'editor@example.test', 'Editor User'],
      [subjectViewer, 'viewer@example.test', 'Viewer User'],
      [subjectSuspended, 'suspended@example.test', 'Suspended User'],
      [subjectNonMember, 'nonmember@example.test', 'NonMember User'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Workspace W', 'shared', 'USD', null, $2),
              ($3, 'Workspace Other', 'shared', 'USD', null, $4)`,
      [workspaceW, subjectOwner, workspaceOther, subjectNonMember],
    );

    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status, joined_at)
       values ($1, $2, $3, 'owner', 'active', '2026-07-15T01:00:00.000Z'),
              ($4, $2, $5, 'administrator', 'active', '2026-07-15T02:00:00.000Z'),
              ($6, $2, $7, 'editor', 'active', '2026-07-15T03:00:00.000Z'),
              ($8, $2, $9, 'viewer', 'active', '2026-07-15T04:00:00.000Z'),
              ($10, $2, $11, 'viewer', 'suspended', '2026-07-15T05:00:00.000Z'),
              ($12, $13, $14, 'owner', 'active', '2026-07-15T06:00:00.000Z')`,
      [
        memOwnerId,
        workspaceW,
        subjectOwner,
        memAdminId,
        subjectAdmin,
        memEditorId,
        subjectEditor,
        memViewerId,
        subjectViewer,
        memSuspendedId,
        subjectSuspended,
        memOtherId,
        workspaceOther,
        subjectNonMember,
      ],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  describe('workspace_member_roster projection', () => {
    it('a plain left join to public.profiles returns the caller own display_name (positive control)', async () => {
      const result = await asSubject(subjectOwner, async (client) => {
        return client.query<{ profile_id: string; display_name: string | null }>(
          `select membership.profile_id, profile.display_name
             from public.workspace_memberships membership
             left join public.profiles profile on profile.id = membership.profile_id
            where membership.workspace_id = $1`,
          [workspaceW],
        );
      });
      const ownRow = result.rows.find((r) => r.profile_id === subjectOwner);
      expect(ownRow).toBeDefined();
      expect(ownRow?.display_name).toBe('Owner User');
    });

    it('a plain left join to public.profiles returns NULL for a peer display_name', async () => {
      const result = await asSubject(subjectOwner, async (client) => {
        return client.query<{ profile_id: string; display_name: string | null }>(
          `select membership.profile_id, profile.display_name
             from public.workspace_memberships membership
             left join public.profiles profile on profile.id = membership.profile_id
            where membership.workspace_id = $1`,
          [workspaceW],
        );
      });
      const peerRows = result.rows.filter((r) => r.profile_id !== subjectOwner);
      expect(peerRows.length).toBeGreaterThan(0);
      for (const peer of peerRows) {
        expect(peer.display_name).toBeNull();
      }
    });

    it('workspace_member_roster returns a non-NULL display_name for every peer', async () => {
      const result = await asSubject(subjectOwner, async (client) => {
        return client.query<{ profile_id: string; display_name: string | null }>(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      const peerRows = result.rows.filter((r) => r.profile_id !== subjectOwner);
      expect(peerRows.length).toBeGreaterThan(0);
      for (const peer of peerRows) {
        expect(peer.display_name).not.toBeNull();
        expect(typeof peer.display_name).toBe('string');
        expect(peer.display_name!.length).toBeGreaterThan(0);
      }
    });

    it('workspace_member_roster projects email for every member when the caller is an owner (positive control)', async () => {
      const result = await asSubject(subjectOwner, async (client) => {
        return client.query<{ email: string | null }>(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      expect(result.rows.length).toBe(5);
      for (const row of result.rows) {
        expect(row.email).not.toBeNull();
        expect(typeof row.email).toBe('string');
        expect(row.email!.length).toBeGreaterThan(0);
      }
    });

    it('workspace_member_roster projects email for every member when the caller is an administrator', async () => {
      const result = await asSubject(subjectAdmin, async (client) => {
        return client.query<{ email: string | null }>(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      expect(result.rows.length).toBe(5);
      for (const row of result.rows) {
        expect(row.email).not.toBeNull();
        expect(typeof row.email).toBe('string');
        expect(row.email!.length).toBeGreaterThan(0);
      }
    });

    it('workspace_member_roster returns the full roster with email NULL for every member when the caller is an editor', async () => {
      const result = await asSubject(subjectEditor, async (client) => {
        return client.query<{ email: string | null }>(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      expect(result.rows.length).toBe(5);
      for (const row of result.rows) {
        expect(row.email).toBeNull();
      }
    });

    it('workspace_member_roster returns the full roster with email NULL for every member when the caller is a viewer', async () => {
      const result = await asSubject(subjectViewer, async (client) => {
        return client.query<{ email: string | null }>(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      expect(result.rows.length).toBe(5);
      for (const row of result.rows) {
        expect(row.email).toBeNull();
      }
    });

    it('workspace_member_roster returns zero rows when the caller has no membership in the workspace', async () => {
      const result = await asSubject(subjectNonMember, async (client) => {
        return client.query(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      expect(result.rows.length).toBe(0);
    });

    it('workspace_member_roster returns zero rows when the caller membership is suspended', async () => {
      const result = await asSubject(subjectSuspended, async (client) => {
        return client.query(
          `select * from public.workspace_member_roster($1)`,
          [workspaceW],
        );
      });
      expect(result.rows.length).toBe(0);
    });

    it('workspace_member_roster declares no privacy_mode_enabled, default_currency or locale column in its return type', async () => {
      const result = await admin.query<{ proargnames: string[] }>(
        `select proargnames from pg_proc where proname = 'workspace_member_roster'`,
      );
      expect(result.rows.length).toBe(1);
      const argNames = result.rows[0].proargnames;
      expect(argNames).toEqual([
        'target_workspace_id',
        'membership_id',
        'profile_id',
        'display_name',
        'email',
        'role',
        'status',
        'joined_at',
        'version',
      ]);
      expect(argNames).not.toContain('privacy_mode_enabled');
      expect(argNames).not.toContain('default_currency');
      expect(argNames).not.toContain('locale');
    });

    it('workspace_member_roster is stable, security definer, and owned by savia_elevated', async () => {
      const result = await admin.query<{
        provolatile: string;
        prosecdef: boolean;
        owner: string;
      }>(
        `select provolatile, prosecdef, pg_get_userbyid(proowner) as owner
           from pg_proc
          where proname = 'workspace_member_roster'`,
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].provolatile).toBe('s');
      expect(result.rows[0].prosecdef).toBe(true);
      expect(result.rows[0].owner).toBe('savia_elevated');
    });

    it('workspace_member_roster is not executable by public and is executable by savia_application', async () => {
      const result = await admin.query<{
        public_exec: boolean;
        app_exec: boolean;
      }>(
        `select has_function_privilege('public', 'public.workspace_member_roster(uuid)', 'execute') as public_exec,
                has_function_privilege('savia_application', 'public.workspace_member_roster(uuid)', 'execute') as app_exec`,
      );
      expect(result.rows[0].public_exec).toBe(false);
      expect(result.rows[0].app_exec).toBe(true);
    });

    it('savia_elevated holds no create privilege on schema public after the migration', async () => {
      const result = await admin.query<{ has_create: boolean }>(
        `select has_schema_privilege('savia_elevated', 'public', 'create') as has_create`,
      );
      expect(result.rows[0].has_create).toBe(false);
    });
  });

  describe('WorkspaceMemberService and PostgresWorkspaceMemberAdapter database boundary', () => {
    it('an active editor receives the full roster with every peer displayName non-null and every email absent', async () => {
      const outcome = await service.listWorkspaceMembers(
        subjectEditor,
        workspaceW,
        { limit: 50 },
      );
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.page.items.length).toBe(5);
      for (const item of outcome.page.items) {
        expect(typeof item.displayName).toBe('string');
        expect(item.displayName.length).toBeGreaterThan(0);
        expect(Object.hasOwn(item, 'email')).toBe(false);
        expect('email' in item).toBe(false);
      }
    });

    it('an active viewer receives the full roster with every peer displayName non-null and every email absent', async () => {
      const outcome = await service.listWorkspaceMembers(
        subjectViewer,
        workspaceW,
        { limit: 50 },
      );
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.page.items.length).toBe(5);
      for (const item of outcome.page.items) {
        expect(typeof item.displayName).toBe('string');
        expect(item.displayName.length).toBeGreaterThan(0);
        expect(Object.hasOwn(item, 'email')).toBe(false);
        expect('email' in item).toBe(false);
      }
    });

    it('an active owner receives the same roster with every peer email present (positive control)', async () => {
      const outcomeOwner = await service.listWorkspaceMembers(
        subjectOwner,
        workspaceW,
        { limit: 50 },
      );
      const outcomeEditor = await service.listWorkspaceMembers(
        subjectEditor,
        workspaceW,
        { limit: 50 },
      );
      expect(outcomeOwner.kind).toBe('ok');
      expect(outcomeEditor.kind).toBe('ok');
      if (outcomeOwner.kind !== 'ok' || outcomeEditor.kind !== 'ok') return;
      expect(outcomeOwner.page.items.map((i) => i.id)).toEqual(
        outcomeEditor.page.items.map((i) => i.id),
      );
      for (const item of outcomeOwner.page.items) {
        expect(typeof item.email).toBe('string');
        expect((item.email ?? '').length).toBeGreaterThan(0);
      }
    });

    it('a non-member receives not-found', async () => {
      const outcome = await service.listWorkspaceMembers(
        subjectNonMember,
        workspaceW,
        { limit: 50 },
      );
      expect(outcome.kind).toBe('not-found');
    });

    it('a suspended member receives forbidden', async () => {
      const outcome = await service.listWorkspaceMembers(
        subjectSuspended,
        workspaceW,
        { limit: 50 },
      );
      expect(outcome.kind).toBe('forbidden');
    });

    it('pages the roster with limit and cursor, concatenating to the full ordered roster with no duplicates and no gaps', async () => {
      const fullOutcome = await service.listWorkspaceMembers(
        subjectOwner,
        workspaceW,
        { limit: 50 },
      );
      expect(fullOutcome.kind).toBe('ok');
      if (fullOutcome.kind !== 'ok') return;
      const fullItems = fullOutcome.page.items;

      const pagedItems: WorkspaceMember[] = [];
      let cursor: ReturnType<typeof decodeMemberCursor> = undefined;
      let hasNextPage = true;

      while (hasNextPage) {
        const pageOutcome = await service.listWorkspaceMembers(
          subjectOwner,
          workspaceW,
          { cursor, limit: 2 },
        );
        expect(pageOutcome.kind).toBe('ok');
        if (pageOutcome.kind !== 'ok') break;
        pagedItems.push(...pageOutcome.page.items);
        hasNextPage = pageOutcome.page.pageInfo.hasNextPage;
        if (pageOutcome.page.pageInfo.nextCursor) {
          cursor = decodeMemberCursor(pageOutcome.page.pageInfo.nextCursor);
        }
      }

      expect(pagedItems.map((i) => i.id)).toEqual(fullItems.map((i) => i.id));
      const ids = pagedItems.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('reports hasNextPage false and nextCursor null on a final page that is exactly full', async () => {
      const outcome = await service.listWorkspaceMembers(
        subjectOwner,
        workspaceW,
        { limit: 5 },
      );
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.page.items.length).toBe(5);
      expect(outcome.page.pageInfo.hasNextPage).toBe(false);
      expect(outcome.page.pageInfo.nextCursor).toBeNull();
    });

    it('never returns privacyModeEnabled, defaultCurrency or locale on any roster item', async () => {
      const outcome = await service.listWorkspaceMembers(
        subjectOwner,
        workspaceW,
        { limit: 50 },
      );
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      for (const item of outcome.page.items) {
        const keys = Object.keys(item);
        expect(
          keys.every((k) =>
            [
              'id',
              'userId',
              'displayName',
              'email',
              'role',
              'status',
              'joinedAt',
            ].includes(k),
          ),
        ).toBe(true);
        expect(keys).not.toContain('privacyModeEnabled');
        expect(keys).not.toContain('defaultCurrency');
        expect(keys).not.toContain('locale');
      }
    });
  });
});
