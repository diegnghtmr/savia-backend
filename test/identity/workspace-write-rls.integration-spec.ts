// Migrations under test: 202607150007_workspace_write_rls.sql, 202607150008_workspace_created_by.sql, 202607150009_workspace_claim_binding.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('Workspace write RLS, grants, and claim binding (202607150007_workspace_write_rls.sql, 202607150008_workspace_created_by.sql, 202607150009_workspace_claim_binding.sql)', () => {
  let admin: Pool;

  const subjectA = subject(901);
  const subjectB = subject(902);
  const subjectEditor = subject(903);
  const subjectAdmin = subject(904);
  const subjectSuspended = subject(905);

  const wsClaimedId = '00000000-0000-0000-0000-000000000950';
  const wsUnclaimedId = '00000000-0000-0000-0000-000000000951';
  const wsUnclaimedId2 = '00000000-0000-0000-0000-000000000952';
  const wsUpdateId = '00000000-0000-0000-0000-000000000953';
  const wsSuspendedUpdateId = '00000000-0000-0000-0000-000000000954';
  const wsDeleteSharedId = '00000000-0000-0000-0000-000000000955';
  const wsPersonalId = '00000000-0000-0000-0000-000000000956';
  const wsAdminDeleteId = '00000000-0000-0000-0000-000000000957';
  const wsSuspendedDeleteId = '00000000-0000-0000-0000-000000000958';

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

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`,
      [
        subjectA,
        'subject-a@example.test',
        subjectB,
        'subject-b@example.test',
        subjectEditor,
        'editor@example.test',
        subjectAdmin,
        'admin@example.test',
        subjectSuspended,
        'suspended@example.test',
      ],
    );

    for (const [id, email, name] of [
      [subjectA, 'subject-a@example.test', 'Subject A'],
      [subjectB, 'subject-b@example.test', 'Subject B'],
      [subjectEditor, 'editor@example.test', 'Editor User'],
      [subjectAdmin, 'admin@example.test', 'Admin User'],
      [subjectSuspended, 'suspended@example.test', 'Suspended User'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    // Seed wsClaimedId (claimed by Subject A as active owner)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Claimed Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsClaimedId, subjectA],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsClaimedId, subjectA],
    );

    // Seed wsUnclaimedId (shared, created by Subject A, no memberships)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Unclaimed Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsUnclaimedId, subjectA],
    );

    // Seed wsUnclaimedId2 (shared, created by Subject A, no memberships)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Unclaimed Shared Workspace 2', 'shared', 'USD', null, $2)`,
      [wsUnclaimedId2, subjectA],
    );

    // Seed wsUpdateId (shared with Subject A as owner, Subject Editor as editor)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Update Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsUpdateId, subjectA],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'editor', 'active')`,
      [wsUpdateId, subjectA, subjectEditor],
    );

    // Seed wsSuspendedUpdateId (shared with Subject Suspended as suspended owner)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Suspended Update Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsSuspendedUpdateId, subjectSuspended],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'suspended')`,
      [wsSuspendedUpdateId, subjectSuspended],
    );

    // Seed wsDeleteSharedId (shared with Subject A as active owner)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Delete Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsDeleteSharedId, subjectA],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsDeleteSharedId, subjectA],
    );

    // Seed wsPersonalId (personal workspace with deferred totality constraint)
    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
       values ($1, 'Personal Workspace A', 'personal', 'USD', $2)`,
      [wsPersonalId, subjectA],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [wsPersonalId, subjectA],
    );
    await admin.query('commit');

    // Seed wsAdminDeleteId (shared with Subject A as owner, Subject Admin as administrator)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Admin Delete Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsAdminDeleteId, subjectA],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'administrator', 'active')`,
      [wsAdminDeleteId, subjectA, subjectAdmin],
    );

    // Seed wsSuspendedDeleteId (shared with Subject Suspended as suspended owner)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Suspended Delete Shared Workspace', 'shared', 'USD', null, $2)`,
      [wsSuspendedDeleteId, subjectSuspended],
    );
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'suspended')`,
      [wsSuspendedDeleteId, subjectSuspended],
    );
  });

  afterAll(async () => {
    await admin.end();
  });

  describe('workspaces INSERT', () => {
    it('subject A inserts kind=shared with created_by=subject A -> INSERT 0 1', async () => {
      const newWsId = crypto.randomUUID();
      const result = await asSubject(subjectA, (client) =>
        client.query(
          `insert into public.workspaces (id, name, kind, base_currency, created_by) values ($1, 'A Shared WS', 'shared', 'USD', $2)`,
          [newWsId, subjectA],
        ),
      );
      expect(result.rowCount).toBe(1);

      const check = await admin.query<{
        kind: string;
        name: string;
        created_by: string;
      }>('select kind, name, created_by from public.workspaces where id = $1', [
        newWsId,
      ]);
      expect(check.rows[0]?.kind).toBe('shared');
      expect(check.rows[0]?.name).toBe('A Shared WS');
      expect(check.rows[0]?.created_by).toBe(subjectA);
    });

    it('subject A inserting kind=personal naming subject B is refused with 42501', async () => {
      const newPersonalId = crypto.randomUUID();
      await expect(
        asSubject(subjectA, (client) =>
          client.query(
            `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id) values ($1, 'Personal B', 'personal', 'USD', $2)`,
            [newPersonalId, subjectB],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('subject A inserting collaborative workspace with forged created_by=subject B is refused with 42501; with created_by=subject A succeeds (positive control)', async () => {
      const forgedWsId = crypto.randomUUID();
      await expect(
        asSubject(subjectA, (client) =>
          client.query(
            `insert into public.workspaces (id, name, kind, base_currency, created_by) values ($1, 'Forged WS', 'shared', 'USD', $2)`,
            [forgedWsId, subjectB],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // Positive control: identical insert with created_by = subjectA succeeds
      const validWsId = crypto.randomUUID();
      const validResult = await asSubject(subjectA, (client) =>
        client.query(
          `insert into public.workspaces (id, name, kind, base_currency, created_by) values ($1, 'Valid WS', 'shared', 'USD', $2)`,
          [validWsId, subjectA],
        ),
      );
      expect(validResult.rowCount).toBe(1);
    });
  });

  describe('memberships INSERT', () => {
    it('subject A inserts owner/active for that shared workspace in the SAME transaction -> INSERT 0 1', async () => {
      const wsId = crypto.randomUUID();
      await asSubject(subjectA, async (client) => {
        const wsRes = await client.query(
          `insert into public.workspaces (id, name, kind, base_currency, created_by) values ($1, 'Atomic Shared WS', 'shared', 'USD', $2)`,
          [wsId, subjectA],
        );
        expect(wsRes.rowCount).toBe(1);

        const memRes = await client.query(
          `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
          [wsId, subjectA],
        );
        expect(memRes.rowCount).toBe(1);
      });

      const memCheck = await admin.query<{ role: string; status: string }>(
        'select role, status from public.workspace_memberships where workspace_id = $1 and profile_id = $2',
        [wsId, subjectA],
      );
      expect(memCheck.rows[0]).toEqual({ role: 'owner', status: 'active' });
    });

    it('victim A commits collaborative workspace with created_by=A and no membership; attacker B claiming it is refused with 42501; creator A claiming it succeeds (positive control)', async () => {
      const wsId = crypto.randomUUID();
      // Step 1: Victim A commits collaborative workspace stamping created_by = subjectA and NO membership
      await asSubject(subjectA, (client) =>
        client.query(
          `insert into public.workspaces (id, name, kind, base_currency, created_by) values ($1, 'Victim WS', 'shared', 'USD', $2)`,
          [wsId, subjectA],
        ),
      );

      // Step 2: Attacker B attempts owner claim -> refused 42501
      await expect(
        asSubject(subjectB, (client) =>
          client.query(
            `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
            [wsId, subjectB],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // Step 3 (Positive control): Creator A claims the same workspace -> INSERT 0 1
      const claimResult = await asSubject(subjectA, (client) =>
        client.query(
          `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
          [wsId, subjectA],
        ),
      );
      expect(claimResult.rowCount).toBe(1);
    });

    it("subject B self-inserting owner/active into A's already-claimed workspace is refused with 42501", async () => {
      await expect(
        asSubject(subjectB, (client) =>
          client.query(
            `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
            [wsClaimedId, subjectB],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('subject A inserting role=viewer into an unclaimed workspace is refused with 42501', async () => {
      await expect(
        asSubject(subjectA, (client) =>
          client.query(
            `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'viewer', 'active')`,
            [wsUnclaimedId, subjectA],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('subject A inserting with profile_id = subject B into an unclaimed workspace is refused with 42501', async () => {
      await expect(
        asSubject(subjectA, (client) =>
          client.query(
            `insert into public.workspace_memberships (workspace_id, profile_id, role, status) values ($1, $2, 'owner', 'active')`,
            [wsUnclaimedId2, subjectB],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('helper public.collaborative_workspace_is_claimable_by direct assertions', () => {
    it('returns true for creator on unclaimed, false for non-creator on unclaimed, false for claimed workspace, and false for nonexistent workspace as savia_application', async () => {
      const claimableByCreator = await asSubject(subjectA, (client) =>
        client.query<{ claimable: boolean }>(
          'select public.collaborative_workspace_is_claimable_by($1, $2) as claimable',
          [wsUnclaimedId, subjectA],
        ),
      );
      expect(claimableByCreator.rows[0]?.claimable).toBe(true);

      const claimableByNonCreator = await asSubject(subjectB, (client) =>
        client.query<{ claimable: boolean }>(
          'select public.collaborative_workspace_is_claimable_by($1, $2) as claimable',
          [wsUnclaimedId, subjectB],
        ),
      );
      expect(claimableByNonCreator.rows[0]?.claimable).toBe(false);

      const claimedRes = await asSubject(subjectA, (client) =>
        client.query<{ claimable: boolean }>(
          'select public.collaborative_workspace_is_claimable_by($1, $2) as claimable',
          [wsClaimedId, subjectA],
        ),
      );
      expect(claimedRes.rows[0]?.claimable).toBe(false);

      const nonexistentRes = await asSubject(subjectA, (client) =>
        client.query<{ claimable: boolean }>(
          'select public.collaborative_workspace_is_claimable_by($1, $2) as claimable',
          [crypto.randomUUID(), subjectA],
        ),
      );
      expect(nonexistentRes.rows[0]?.claimable).toBe(false);
    });
  });

  describe('workspaces UPDATE', () => {
    it('active owner sets name -> UPDATE 1 and version increments by exactly 1', async () => {
      const before = await admin.query<{ version: number }>(
        'select version from public.workspaces where id = $1',
        [wsUpdateId],
      );
      const initialVersion = before.rows[0]!.version;

      const updateRes = await asSubject(subjectA, (client) =>
        client.query(
          `update public.workspaces set name = 'Renamed Workspace', version = version + 1 where id = $1`,
          [wsUpdateId],
        ),
      );
      expect(updateRes.rowCount).toBe(1);

      const after = await admin.query<{ version: number; name: string }>(
        'select version, name from public.workspaces where id = $1',
        [wsUpdateId],
      );
      expect(after.rows[0]?.version).toBe(initialVersion + 1);
      expect(after.rows[0]?.name).toBe('Renamed Workspace');
    });

    it('editor updating workspace returns UPDATE 0', async () => {
      const updateRes = await asSubject(subjectEditor, (client) =>
        client.query(
          `update public.workspaces set name = 'Editor Update', version = version + 1 where id = $1`,
          [wsUpdateId],
        ),
      );
      expect(updateRes.rowCount).toBe(0);
    });

    it("suspended owner cannot update: the read policy already hides the row, so the write policy's status clause is unobservable defense in depth", async () => {
      // This test asserts combined read+write policy behavior; the read policy already hides the row from a suspended member, so this case cannot isolate the write policy's status = 'active' clause (see administrator DELETE case for write policy role clause isolation).
      const updateRes = await asSubject(subjectSuspended, (client) =>
        client.query(
          `update public.workspaces set name = 'Suspended Update', version = version + 1 where id = $1`,
          [wsSuspendedUpdateId],
        ),
      );
      expect(updateRes.rowCount).toBe(0);
    });

    it('active owner running set kind=personal is refused with 42501 at GRANT level', async () => {
      await expect(
        asSubject(subjectA, (client) =>
          client.query(
            `update public.workspaces set kind = 'personal' where id = $1`,
            [wsUpdateId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('workspaces DELETE', () => {
    it('active owner deletes a shared workspace -> DELETE 1 and the row is gone', async () => {
      const deleteRes = await asSubject(subjectA, (client) =>
        client.query(`delete from public.workspaces where id = $1`, [
          wsDeleteSharedId,
        ]),
      );
      expect(deleteRes.rowCount).toBe(1);

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsDeleteSharedId],
      );
      expect(check.rows).toHaveLength(0);
    });

    it('owner deletes a personal workspace -> DELETE 0 AND the row is still present', async () => {
      const deleteRes = await asSubject(subjectA, (client) =>
        client.query(`delete from public.workspaces where id = $1`, [
          wsPersonalId,
        ]),
      );
      expect(deleteRes.rowCount).toBe(0);

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsPersonalId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it('administrator on a shared workspace deleting returns DELETE 0 and row is still present', async () => {
      const deleteRes = await asSubject(subjectAdmin, (client) =>
        client.query(`delete from public.workspaces where id = $1`, [
          wsAdminDeleteId,
        ]),
      );
      expect(deleteRes.rowCount).toBe(0);

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsAdminDeleteId],
      );
      expect(check.rows).toHaveLength(1);
    });

    it("suspended owner cannot delete: the read policy already hides the row, so the write policy's status clause is unobservable defense in depth", async () => {
      // This test asserts combined read+write policy behavior; the read policy already hides the row from a suspended member, so this case cannot isolate the write policy's status = 'active' clause (see administrator DELETE case for write policy role clause isolation).
      const deleteRes = await asSubject(subjectSuspended, (client) =>
        client.query(`delete from public.workspaces where id = $1`, [
          wsSuspendedDeleteId,
        ]),
      );
      expect(deleteRes.rowCount).toBe(0);

      const check = await admin.query(
        'select 1 from public.workspaces where id = $1',
        [wsSuspendedDeleteId],
      );
      expect(check.rows).toHaveLength(1);
    });
  });

  describe('savia_elevated privilege narrowing', () => {
    it('savia_elevated can select workspaces (positive control) but cannot create tables in schema public (negative)', async () => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role savia_elevated');

        // Positive control: savia_elevated can select from public.workspaces
        const selectRes = await client.query(
          'select count(*)::int from public.workspaces',
        );
        expect(selectRes.rows).toHaveLength(1);

        // Negative: savia_elevated cannot create tables in schema public (create privilege was revoked)
        await expect(
          client.query('create table public.elevated_probe (x int)'),
        ).rejects.toMatchObject({ code: '42501' });

        await client.query('rollback');
      } finally {
        client.release();
      }
    });
  });
});
