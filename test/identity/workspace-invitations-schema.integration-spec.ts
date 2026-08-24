// Migrations under test: 202607150014_workspace_invitations.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('Workspace invitations schema, constraints, RLS, and helper (202607150014_workspace_invitations.sql)', () => {
  let admin: Pool;

  const ownerA = subject(801);
  const ownerB = subject(802);
  const adminC = subject(803);
  const editorD = subject(804);
  const viewerE = subject(805);
  const targetF = subject(806);
  const personalOwnerH = subject(807);
  const suspendedS = subject(808);
  const outsiderZ = subject(809);
  const disposableSubject1 = subject(810);
  const disposableSubject2 = subject(811);
  const disposableSubject3 = subject(812);
  const disposableSubject4 = subject(813);
  const disposableSubject5 = subject(814);

  const ws1Id = '00000000-0000-0000-0000-000000000851';
  const ws2Id = '00000000-0000-0000-0000-000000000852';
  const wsPersonalId = '00000000-0000-0000-0000-000000000853';
  const wsFamilyId = '00000000-0000-0000-0000-000000000854';

  const memOwnerAId = '00000000-0000-0000-0000-000000000861';
  const memOwnerBId = '00000000-0000-0000-0000-000000000862';
  const memAdminCId = '00000000-0000-0000-0000-000000000863';
  const memEditorDId = '00000000-0000-0000-0000-000000000864';
  const memViewerEId = '00000000-0000-0000-0000-000000000865';
  const memTargetFId = '00000000-0000-0000-0000-000000000866';
  const memSuspendedSId = '00000000-0000-0000-0000-000000000867';
  const memWs2OwnerBId = '00000000-0000-0000-0000-000000000868';
  const memPersonalOwnerHId = '00000000-0000-0000-0000-000000000869';
  const memFamilyOwnerAId = '00000000-0000-0000-0000-000000000870';

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
      `insert into auth.users (id, email) values
       ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10),
       ($11, $12), ($13, $14), ($15, $16), ($17, $18), ($19, $20),
       ($21, $22), ($23, $24), ($25, $26), ($27, $28)`,
      [
        ownerA,
        'owner-a@example.test',
        ownerB,
        'owner-b@example.test',
        adminC,
        'admin-c@example.test',
        editorD,
        'editor-d@example.test',
        viewerE,
        'viewer-e@example.test',
        targetF,
        'target-f@example.test',
        personalOwnerH,
        'personal-owner-h@example.test',
        suspendedS,
        'suspended-s@example.test',
        outsiderZ,
        'outsider-z@example.test',
        disposableSubject1,
        'disposable-1@example.test',
        disposableSubject2,
        'disposable-2@example.test',
        disposableSubject3,
        'disposable-3@example.test',
        disposableSubject4,
        'disposable-4@example.test',
        disposableSubject5,
        'disposable-5@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerA, 'owner-a@example.test', 'Owner A'],
      [ownerB, 'owner-b@example.test', 'Owner B'],
      [adminC, 'admin-c@example.test', 'Admin C'],
      [editorD, 'editor-d@example.test', 'Editor D'],
      [viewerE, 'viewer-e@example.test', 'Viewer E'],
      [targetF, 'target-f@example.test', 'Target F'],
      [personalOwnerH, 'personal-owner-h@example.test', 'Personal Owner H'],
      [suspendedS, 'suspended-s@example.test', 'Suspended S'],
      [outsiderZ, 'outsider-z@example.test', 'Outsider Z'],
      [disposableSubject1, 'disposable-1@example.test', 'Disposable 1'],
      [disposableSubject2, 'disposable-2@example.test', 'Disposable 2'],
      [disposableSubject3, 'disposable-3@example.test', 'Disposable 3'],
      [disposableSubject4, 'disposable-4@example.test', 'Disposable 4'],
      [disposableSubject5, 'disposable-5@example.test', 'Disposable 5'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    // Seed shared workspace W1
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Shared Workspace 1', 'shared', 'USD', null, $2)`,
      [ws1Id, ownerA],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'owner', 'active'),
              ($7, $8, $9, 'administrator', 'active'),
              ($10, $11, $12, 'editor', 'active'),
              ($13, $14, $15, 'viewer', 'active'),
              ($16, $17, $18, 'editor', 'active'),
              ($19, $20, $21, 'editor', 'suspended')`,
      [
        memOwnerAId,
        ws1Id,
        ownerA,
        memOwnerBId,
        ws1Id,
        ownerB,
        memAdminCId,
        ws1Id,
        adminC,
        memEditorDId,
        ws1Id,
        editorD,
        memViewerEId,
        ws1Id,
        viewerE,
        memTargetFId,
        ws1Id,
        targetF,
        memSuspendedSId,
        ws1Id,
        suspendedS,
      ],
    );

    // Seed shared workspace W2
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Shared Workspace 2', 'shared', 'USD', null, $2)`,
      [ws2Id, ownerB],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memWs2OwnerBId, ws2Id, ownerB],
    );

    // Seed personal workspace P
    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Personal Workspace', 'personal', 'USD', $2, $2)`,
      [wsPersonalId, personalOwnerH],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memPersonalOwnerHId, wsPersonalId, personalOwnerH],
    );
    await admin.query('commit');

    // Seed family workspace F
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Family Workspace', 'family', 'USD', null, $2)`,
      [wsFamilyId, ownerA],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memFamilyOwnerAId, wsFamilyId, ownerA],
    );
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe('3.1 Structure and ACL', () => {
    it('1. The table exists with relrowsecurity AND relforcerowsecurity both true', async () => {
      const rlsRes = await admin.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
         from pg_class
         where oid = 'public.workspace_invitations'::regclass`,
      );
      expect(rlsRes.rows[0].relrowsecurity).toBe(true);
      expect(rlsRes.rows[0].relforcerowsecurity).toBe(true);
    });

    it('2. savia_application holds SELECT, and INSERT on exactly (workspace_id, email, role, expires_at, invited_by) and UPDATE on exactly (status)', async () => {
      const result = await admin.query<{
        column_name: string;
        readable: boolean;
        insertable: boolean;
        updatable: boolean;
      }>(
        `select column_name,
                has_column_privilege('savia_application', 'public.workspace_invitations', column_name, 'select') as readable,
                has_column_privilege('savia_application', 'public.workspace_invitations', column_name, 'insert') as insertable,
                has_column_privilege('savia_application', 'public.workspace_invitations', column_name, 'update') as updatable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'workspace_invitations'
          order by column_name`,
      );

      const readable = result.rows
        .filter((r) => r.readable)
        .map((r) => r.column_name);
      expect(readable).toEqual([
        'created_at',
        'email',
        'expires_at',
        'id',
        'invited_by',
        'role',
        'status',
        'workspace_id',
      ]);

      const insertable = result.rows
        .filter((r) => r.insertable)
        .map((r) => r.column_name);
      expect(insertable).toEqual([
        'email',
        'expires_at',
        'invited_by',
        'role',
        'workspace_id',
      ]);

      const updatable = result.rows
        .filter((r) => r.updatable)
        .map((r) => r.column_name);
      expect(updatable).toEqual(['status']);
    });

    it('3. savia_application holds NO delete privilege on the table', async () => {
      const delResult = await admin.query<{ has_delete: boolean }>(
        `select has_table_privilege('savia_application', 'public.workspace_invitations', 'delete') as has_delete`,
      );
      expect(delResult.rows[0].has_delete).toBe(false);
    });

    it('4. workspace_email_has_active_member is stable, security definer, owned by savia_elevated, not executable by public, executable by savia_application', async () => {
      const funcMetaRes = await admin.query<{
        provolatile: string;
        prosecdef: boolean;
        owner: string;
        public_exec: boolean;
        app_exec: boolean;
      }>(
        `select p.provolatile, p.prosecdef, pg_get_userbyid(p.proowner) as owner,
                has_function_privilege('public', 'public.workspace_email_has_active_member(uuid, text)', 'execute') as public_exec,
                has_function_privilege('savia_application', 'public.workspace_email_has_active_member(uuid, text)', 'execute') as app_exec
         from pg_proc p
         where p.proname = 'workspace_email_has_active_member'`,
      );
      expect(funcMetaRes.rows[0].provolatile).toBe('s');
      expect(funcMetaRes.rows[0].prosecdef).toBe(true);
      expect(funcMetaRes.rows[0].owner).toBe('savia_elevated');
      expect(funcMetaRes.rows[0].public_exec).toBe(false);
      expect(funcMetaRes.rows[0].app_exec).toBe(true);
    });

    it('5. savia_elevated holds no create on schema public after the migration', async () => {
      const elevatedCreateRes = await admin.query<{ has_create: boolean }>(
        `select has_schema_privilege('savia_elevated', 'public', 'create') as has_create`,
      );
      expect(elevatedCreateRes.rows[0].has_create).toBe(false);
    });
  });

  describe('3.2 Constraints', () => {
    it("6. status rejects 'expired' with 23514 (RULING 15); positive control: pending, accepted and revoked succeed", async () => {
      const future = new Date(Date.now() + 86400000).toISOString();

      await expect(
        admin.query(
          `insert into public.workspace_invitations (workspace_id, email, role, status, expires_at, invited_by)
           values ($1, 'expired-test@example.test', 'editor', 'expired', $2, $3)`,
          [ws1Id, future, ownerA],
        ),
      ).rejects.toMatchObject({ code: '23514' });

      // Positive controls: pending, accepted, revoked
      const invPendingId = '00000000-0000-0000-0000-000000000881';
      const invAcceptedId = '00000000-0000-0000-0000-000000000882';
      const invRevokedId = '00000000-0000-0000-0000-000000000883';

      try {
        await admin.query(
          `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
           values ($1, $2, 'pending-test@example.test', 'editor', 'pending', $3, $4),
                  ($5, $2, 'accepted-test@example.test', 'editor', 'accepted', $3, $4),
                  ($6, $2, 'revoked-test@example.test', 'editor', 'revoked', $3, $4)`,
          [invPendingId, ws1Id, future, ownerA, invAcceptedId, invRevokedId],
        );

        const checkRes = await admin.query(
          `select id, status from public.workspace_invitations where id in ($1, $2, $3)`,
          [invPendingId, invAcceptedId, invRevokedId],
        );
        expect(checkRes.rows).toHaveLength(3);
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id in ($1, $2, $3)`,
          [invPendingId, invAcceptedId, invRevokedId],
        );
      }
    });

    it('7. role rejects a value outside the four, raising 23514', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      await expect(
        admin.query(
          `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
           values ($1, 'bad-role@example.test', 'superadmin', $2, $3)`,
          [ws1Id, future, ownerA],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('8. An email longer than 320 characters raises 23514', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const longEmail = 'a'.repeat(308) + '@example.test'; // length 321
      expect(longEmail.length).toBe(321);

      await expect(
        admin.query(
          `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
           values ($1, $2, 'editor', $3, $4)`,
          [ws1Id, longEmail, future, ownerA],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('8b. An email shorter than 3 characters is refused with 23514', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      await expect(
        admin.query(
          `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
           values ($1, $2, 'editor', $3, $4)`,
          [ws1Id, 'ab', future, ownerA],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('9. An email containing a NUL byte fails, and the test asserts the SQLSTATE it actually produces', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      let capturedError: { code?: string } | undefined;

      try {
        await admin.query(
          `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
           values ($1, $2, 'editor', $3, $4)`,
          [ws1Id, 'nul\x00byte@example.test', future, ownerA],
        );
      } catch (err: unknown) {
        capturedError = err as { code?: string };
      }

      expect(capturedError).toBeDefined();
      expect(capturedError?.code).toBe('22021');
    });

    it('10. The partial unique index refuses a second pending invitation for the same (workspace_id, email) with 23505, and refuses it for a differently-cased email; positive controls: second succeeds once first is revoked, and same email in different workspace succeeds', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const invId1 = '00000000-0000-0000-0000-000000000884';
      const invId2 = '00000000-0000-0000-0000-000000000885';

      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'ada@example.test', 'editor', 'pending', $3, $4)`,
        [invId1, ws1Id, future, ownerA],
      );

      try {
        // Exact duplicate
        await expect(
          admin.query(
            `insert into public.workspace_invitations (workspace_id, email, role, status, expires_at, invited_by)
             values ($1, 'ada@example.test', 'editor', 'pending', $2, $3)`,
            [ws1Id, future, ownerA],
          ),
        ).rejects.toMatchObject({ code: '23505' });

        // Differently-cased duplicate
        await expect(
          admin.query(
            `insert into public.workspace_invitations (workspace_id, email, role, status, expires_at, invited_by)
             values ($1, 'Ada@Example.test', 'editor', 'pending', $2, $3)`,
            [ws1Id, future, ownerA],
          ),
        ).rejects.toMatchObject({ code: '23505' });

        // Positive control 1: same email in a DIFFERENT workspace succeeds
        await admin.query(
          `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
           values ($1, $2, 'ada@example.test', 'editor', 'pending', $3, $4)`,
          [invId2, ws2Id, future, ownerB],
        );

        // Positive control 2: second invitation succeeds once first is revoked
        await admin.query(
          `update public.workspace_invitations set status = 'revoked' where id = $1`,
          [invId1],
        );

        const invId3 = '00000000-0000-0000-0000-000000000886';
        await admin.query(
          `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
           values ($1, $2, 'ada@example.test', 'editor', 'pending', $3, $4)`,
          [invId3, ws1Id, future, ownerA],
        );

        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId3],
        );
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id in ($1, $2)`,
          [invId1, invId2],
        );
      }
    });

    it('11. Deleting a workspace cascades its invitations away', async () => {
      const disposableWsId = '00000000-0000-0000-0000-000000000887';
      const disposableMemId = '00000000-0000-0000-0000-000000000888';
      const disposableInvId = '00000000-0000-0000-0000-000000000889';
      const future = new Date(Date.now() + 86400000).toISOString();

      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, created_by)
         values ($1, 'Disposable Cascade WS', 'shared', 'USD', $2)`,
        [disposableWsId, ownerA],
      );
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [disposableMemId, disposableWsId, ownerA],
      );
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, expires_at, invited_by)
         values ($1, $2, 'cascade-test@example.test', 'editor', $3, $4)`,
        [disposableInvId, disposableWsId, future, ownerA],
      );

      // Verify invitation exists
      const beforeRes = await admin.query(
        'select 1 from public.workspace_invitations where id = $1',
        [disposableInvId],
      );
      expect(beforeRes.rows).toHaveLength(1);

      // Delete workspace
      await admin.query('delete from public.workspaces where id = $1', [
        disposableWsId,
      ]);

      // Verify invitation was cascaded away
      const afterRes = await admin.query(
        'select 1 from public.workspace_invitations where id = $1',
        [disposableInvId],
      );
      expect(afterRes.rows).toHaveLength(0);
    });

    it('12. Deleting a profiles row that an invitation references as invited_by is REFUSED (23503), proving on delete restrict', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const disposableInvId = '00000000-0000-0000-0000-000000000890';

      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, expires_at, invited_by)
         values ($1, $2, 'restrict-test@example.test', 'editor', $3, $4)`,
        [disposableInvId, ws1Id, future, disposableSubject1],
      );

      try {
        await expect(
          admin.query('delete from public.profiles where id = $1', [
            disposableSubject1,
          ]),
        ).rejects.toMatchObject({ code: '23503' });
      } finally {
        await admin.query(
          'delete from public.workspace_invitations where id = $1',
          [disposableInvId],
        );
      }
    });
  });

  describe('3.3 RLS behaviour', () => {
    const invWs1Id = '00000000-0000-0000-0000-000000000891';
    const invWs2Id = '00000000-0000-0000-0000-000000000892';
    const future = new Date(Date.now() + 86400000).toISOString();

    beforeAll(async () => {
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'invite-ws1@example.test', 'editor', 'pending', $3, $4),
                ($5, $6, 'invite-ws2@example.test', 'editor', 'pending', $3, $7)`,
        [invWs1Id, ws1Id, future, ownerA, invWs2Id, ws2Id, ownerB],
      );
    });

    afterAll(async () => {
      await admin.query(
        `delete from public.workspace_invitations where id in ($1, $2)`,
        [invWs1Id, invWs2Id],
      );
    });

    it("13. An owner of workspace A sees A's invitations and not B's", async () => {
      const resWs1 = await asSubject(ownerA, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(resWs1.rows.map((r) => r.id)).toContain(invWs1Id);

      const resWs2 = await asSubject(ownerA, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws2Id],
        );
      });
      expect(resWs2.rows).toHaveLength(0);
    });

    it("14. An administrator of A sees A's invitations", async () => {
      const res = await asSubject(adminC, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(res.rows.map((r) => r.id)).toContain(invWs1Id);
    });

    it('15. An editor of A sees ZERO invitations; positive control in the same test: owner query returns rows', async () => {
      const editorRes = await asSubject(editorD, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(editorRes.rows).toHaveLength(0);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(ownerRes.rows.length).toBeGreaterThan(0);
    });

    it('16. A viewer of A sees zero; positive control in the same test: owner query returns rows', async () => {
      const viewerRes = await asSubject(viewerE, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(viewerRes.rows).toHaveLength(0);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(ownerRes.rows.length).toBeGreaterThan(0);
    });

    it('17. A non-member sees zero', async () => {
      const outsiderRes = await asSubject(outsiderZ, async (client) => {
        return client.query(
          'select id from public.workspace_invitations where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(outsiderRes.rows).toHaveLength(0);
    });

    it('18. A suspended owner sees zero (helper requires status = active)', async () => {
      const suspendedOwnerMemId = '00000000-0000-0000-0000-000000000893';
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'suspended')`,
        [suspendedOwnerMemId, ws1Id, disposableSubject2],
      );

      try {
        const suspendedRes = await asSubject(
          disposableSubject2,
          async (client) => {
            return client.query(
              'select id from public.workspace_invitations where workspace_id = $1',
              [ws1Id],
            );
          },
        );
        expect(suspendedRes.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [suspendedOwnerMemId],
        );
      }
    });

    it('19. An editor cannot INSERT (the policy refuses); positive control: an owner can', async () => {
      await expect(
        asSubject(editorD, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'editor-ins@example.test', 'viewer', $2, $3)`,
            [ws1Id, future, editorD],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      // Positive control: ownerA inserts
      let insertId: string | undefined;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'owner-ins@example.test', 'viewer', $2, $3)
             returning id`,
            [ws1Id, future, ownerA],
          );
        });
        insertId = res.rows[0]?.id;
        expect(insertId).toBeDefined();

        const check = await admin.query(
          'select 1 from public.workspace_invitations where id = $1',
          [insertId],
        );
        expect(check.rows).toHaveLength(1);
      } finally {
        if (insertId) {
          await admin.query(
            'delete from public.workspace_invitations where id = $1',
            [insertId],
          );
        }
      }
    });

    it('20. An administrator cannot insert an invitation with role = owner; an owner can (RULING 7)', async () => {
      // Negative: administrator inserts role = 'owner'
      await expect(
        asSubject(adminC, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'admin-owner-ins@example.test', 'owner', $2, $3)`,
            [ws1Id, future, adminC],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      // Positive control 1: administrator inserts role = 'editor'
      let adminInsId: string | undefined;
      try {
        const res = await asSubject(adminC, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'admin-editor-ins@example.test', 'editor', $2, $3)
             returning id`,
            [ws1Id, future, adminC],
          );
        });
        adminInsId = res.rows[0]?.id;
        expect(adminInsId).toBeDefined();

        const checkAdmin = await admin.query(
          'select 1 from public.workspace_invitations where id = $1',
          [adminInsId],
        );
        expect(checkAdmin.rows).toHaveLength(1);
      } finally {
        if (adminInsId) {
          await admin.query(
            'delete from public.workspace_invitations where id = $1',
            [adminInsId],
          );
        }
      }

      // Positive control 2: owner inserts role = 'owner'
      let ownerInsId: string | undefined;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'owner-owner-ins@example.test', 'owner', $2, $3)
             returning id`,
            [ws1Id, future, ownerA],
          );
        });
        ownerInsId = res.rows[0]?.id;
        expect(ownerInsId).toBeDefined();

        const checkOwner = await admin.query(
          'select 1 from public.workspace_invitations where id = $1',
          [ownerInsId],
        );
        expect(checkOwner.rows).toHaveLength(1);
      } finally {
        if (ownerInsId) {
          await admin.query(
            'delete from public.workspace_invitations where id = $1',
            [ownerInsId],
          );
        }
      }
    });

    it('20b. Inserting with invited_by set to a different active profile in the same workspace is refused with 42501', async () => {
      await expect(
        asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'forged-inviter@example.test', 'editor', $2, $3)`,
            [ws1Id, future, ownerB],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('20c. Positive control: inserting with invited_by set to the acting subject succeeds', async () => {
      let legitInsId: string | undefined;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'legit-inviter@example.test', 'editor', $2, $3)
             returning id`,
            [ws1Id, future, ownerA],
          );
        });
        legitInsId = res.rows[0]?.id;
        expect(legitInsId).toBeDefined();

        const checkLegit = await admin.query(
          'select 1 from public.workspace_invitations where id = $1',
          [legitInsId],
        );
        expect(checkLegit.rows).toHaveLength(1);
      } finally {
        if (legitInsId) {
          await admin.query(
            'delete from public.workspace_invitations where id = $1',
            [legitInsId],
          );
        }
      }
    });

    it('21. An INSERT into a personal workspace is refused for every role including its owner; positive control: the same insert into a family workspace succeeds', async () => {
      // Negative: personal workspace owner inserts invitation
      await expect(
        asSubject(personalOwnerH, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'personal-inv@example.test', 'viewer', $2, $3)`,
            [wsPersonalId, future, personalOwnerH],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      // Positive control: insert into family workspace succeeds
      let familyInvId: string | undefined;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `insert into public.workspace_invitations (workspace_id, email, role, expires_at, invited_by)
             values ($1, 'family-inv@example.test', 'editor', $2, $3)
             returning id`,
            [wsFamilyId, future, ownerA],
          );
        });
        familyInvId = res.rows[0]?.id;
        expect(familyInvId).toBeDefined();

        const checkFamily = await admin.query(
          'select 1 from public.workspace_invitations where id = $1',
          [familyInvId],
        );
        expect(checkFamily.rows).toHaveLength(1);
      } finally {
        if (familyInvId) {
          await admin.query(
            'delete from public.workspace_invitations where id = $1',
            [familyInvId],
          );
        }
      }
    });

    it('22. A caller cannot UPDATE an invitation in a workspace they do not administer', async () => {
      // Editor of ws1 attempts update on ws1 invitation
      let editorRowCount = 0;
      try {
        const res = await asSubject(editorD, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'revoked' where id = $1`,
            [invWs1Id],
          );
        });
        editorRowCount = res.rowCount ?? 0;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42501') throw err;
      }
      expect(editorRowCount).toBe(0);

      // Viewer of ws1 attempts update on ws1 invitation
      let viewerRowCount = 0;
      try {
        const res = await asSubject(viewerE, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'revoked' where id = $1`,
            [invWs1Id],
          );
        });
        viewerRowCount = res.rowCount ?? 0;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42501') throw err;
      }
      expect(viewerRowCount).toBe(0);

      // Outsider attempts update on ws1 invitation
      let outsiderRowCount = 0;
      try {
        const res = await asSubject(outsiderZ, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'revoked' where id = $1`,
            [invWs1Id],
          );
        });
        outsiderRowCount = res.rowCount ?? 0;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42501') throw err;
      }
      expect(outsiderRowCount).toBe(0);

      // Owner of ws1 (ownerA, non-admin of ws2) attempts update on ws2 invitation
      let ownerANonWs2RowCount = 0;
      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'revoked' where id = $1`,
            [invWs2Id],
          );
        });
        ownerANonWs2RowCount = res.rowCount ?? 0;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42501') throw err;
      }
      expect(ownerANonWs2RowCount).toBe(0);

      // Verify invWs1 and invWs2 are still pending
      const check1 = await admin.query(
        'select status from public.workspace_invitations where id = $1',
        [invWs1Id],
      );
      expect(check1.rows[0].status).toBe('pending');

      const check2 = await admin.query(
        'select status from public.workspace_invitations where id = $1',
        [invWs2Id],
      );
      expect(check2.rows[0].status).toBe('pending');
    });

    it('22b. accepted -> pending as an owner updates zero rows and leaves stored status as accepted', async () => {
      const invId = '00000000-0000-0000-0000-000000000894';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'accepted-to-pending@example.test', 'editor', 'accepted', $3, $4)`,
        [invId, ws1Id, future, ownerA],
      );

      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'pending' where id = $1`,
            [invId],
          );
        });
        expect(res.rowCount).toBe(0);

        const check = await admin.query(
          `select status from public.workspace_invitations where id = $1`,
          [invId],
        );
        expect(check.rows[0].status).toBe('accepted');
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId],
        );
      }
    });

    it('22c. revoked -> pending as an owner updates zero rows and leaves stored status as revoked', async () => {
      const invId = '00000000-0000-0000-0000-000000000895';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'revoked-to-pending@example.test', 'editor', 'revoked', $3, $4)`,
        [invId, ws1Id, future, ownerA],
      );

      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'pending' where id = $1`,
            [invId],
          );
        });
        expect(res.rowCount).toBe(0);

        const check = await admin.query(
          `select status from public.workspace_invitations where id = $1`,
          [invId],
        );
        expect(check.rows[0].status).toBe('revoked');
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId],
        );
      }
    });

    it('22d. Positive control: pending -> revoked as an owner updates exactly one row', async () => {
      const invId = '00000000-0000-0000-0000-000000000896';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'pending-to-revoked@example.test', 'editor', 'pending', $3, $4)`,
        [invId, ws1Id, future, ownerA],
      );

      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'revoked' where id = $1`,
            [invId],
          );
        });
        expect(res.rowCount).toBe(1);

        const check = await admin.query(
          `select status from public.workspace_invitations where id = $1`,
          [invId],
        );
        expect(check.rows[0].status).toBe('revoked');
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId],
        );
      }
    });

    it('22e. Positive control: pending -> accepted as an owner updates exactly one row', async () => {
      const invId = '00000000-0000-0000-0000-000000000897';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'pending-to-accepted@example.test', 'editor', 'pending', $3, $4)`,
        [invId, ws1Id, future, ownerA],
      );

      try {
        const res = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'accepted' where id = $1`,
            [invId],
          );
        });
        expect(res.rowCount).toBe(1);

        const check = await admin.query(
          `select status from public.workspace_invitations where id = $1`,
          [invId],
        );
        expect(check.rows[0].status).toBe('accepted');
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId],
        );
      }
    });

    it('22f. pending -> pending as an owner is refused by with-check and raises 42501', async () => {
      const invId = '00000000-0000-0000-0000-000000000899';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'pending-to-pending@example.test', 'editor', 'pending', $3, $4)`,
        [invId, ws1Id, future, ownerA],
      );

      try {
        await expect(
          asSubject(ownerA, async (client) => {
            return client.query(
              `update public.workspace_invitations set status = 'pending' where id = $1`,
              [invId],
            );
          }),
        ).rejects.toMatchObject({ code: '42501' });

        const check = await admin.query(
          `select status from public.workspace_invitations where id = $1`,
          [invId],
        );
        expect(check.rows[0].status).toBe('pending');
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId],
        );
      }
    });

    it('22g. An administrator (not an owner) performs pending -> revoked and it updates exactly one row', async () => {
      const invId = '00000000-0000-0000-0000-00000000089a';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'admin-revoke-test@example.test', 'editor', 'pending', $3, $4)`,
        [invId, ws1Id, future, ownerA],
      );

      try {
        const res = await asSubject(adminC, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'revoked' where id = $1`,
            [invId],
          );
        });
        expect(res.rowCount).toBe(1);

        const check = await admin.query(
          `select status from public.workspace_invitations where id = $1`,
          [invId],
        );
        expect(check.rows[0].status).toBe('revoked');
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [invId],
        );
      }
    });

    it('23. Column-scope proof: an UPDATE attempting to change workspace_id fails with 42501 (permission denied), because the grant covers only status; positive control: an UPDATE of status alone succeeds', async () => {
      // Attempting to update workspace_id fails with 42501 at GRANT level
      await expect(
        asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set workspace_id = $1 where id = $2`,
            [ws2Id, invWs1Id],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      // Attempting to update role fails with 42501 at GRANT level
      await expect(
        asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set role = 'viewer' where id = $1`,
            [invWs1Id],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      // Positive control: update of status alone succeeds on a dedicated fixture row
      const fixtureInvId = '00000000-0000-0000-0000-000000000898';
      await admin.query(
        `insert into public.workspace_invitations (id, workspace_id, email, role, status, expires_at, invited_by)
         values ($1, $2, 'col-scope-fixture@example.test', 'editor', 'pending', $3, $4)`,
        [fixtureInvId, ws1Id, future, ownerA],
      );

      try {
        const updateRes = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_invitations set status = 'accepted' where id = $1`,
            [fixtureInvId],
          );
        });
        expect(updateRes.rowCount).toBe(1);

        const check = await admin.query(
          'select status, workspace_id from public.workspace_invitations where id = $1',
          [fixtureInvId],
        );
        expect(check.rows[0].status).toBe('accepted');
        expect(check.rows[0].workspace_id).toBe(ws1Id);
      } finally {
        await admin.query(
          `delete from public.workspace_invitations where id = $1`,
          [fixtureInvId],
        );
      }
    });
  });

  describe('3.4 The helper: workspace_email_has_active_member', () => {
    it("24. workspace_email_has_active_member returns true for an active member's email, false for a non-member's email, and false for a suspended member's email", async () => {
      // Active member (editorD)
      const activeRes = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'editor-d@example.test'],
        );
        return res.rows[0].result;
      });
      expect(activeRes).toBe(true);

      // Non-member (outsiderZ)
      const nonMemberRes = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'outsider-z@example.test'],
        );
        return res.rows[0].result;
      });
      expect(nonMemberRes).toBe(false);

      // Suspended member (suspendedS)
      const suspendedRes = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'suspended-s@example.test'],
        );
        return res.rows[0].result;
      });
      expect(suspendedRes).toBe(false);
    });

    it('25. It returns false when the CALLER is not an active owner/administrator of that workspace, proving it cannot be used as an oracle to probe membership of workspaces the caller does not administer', async () => {
      // Caller is editor (editorD)
      const editorCallerRes = await asSubject(editorD, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'owner-a@example.test'],
        );
        return res.rows[0].result;
      });
      expect(editorCallerRes).toBe(false);

      // Caller is viewer (viewerE)
      const viewerCallerRes = await asSubject(viewerE, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'owner-a@example.test'],
        );
        return res.rows[0].result;
      });
      expect(viewerCallerRes).toBe(false);

      // Caller is outsider (outsiderZ)
      const outsiderCallerRes = await asSubject(outsiderZ, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'owner-a@example.test'],
        );
        return res.rows[0].result;
      });
      expect(outsiderCallerRes).toBe(false);

      // Caller is suspended member (suspendedS)
      const suspendedCallerRes = await asSubject(suspendedS, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'owner-a@example.test'],
        );
        return res.rows[0].result;
      });
      expect(suspendedCallerRes).toBe(false);

      // Caller is owner of ws2 (ownerB), querying ws1 where they are also owner, but let's test caller who is NOT admin in target workspace:
      // outsider querying ws2
      const outsiderWs2Res = await asSubject(outsiderZ, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws2Id, 'owner-b@example.test'],
        );
        return res.rows[0].result;
      });
      expect(outsiderWs2Res).toBe(false);
    });

    it('26. It matches case-insensitively', async () => {
      const caseRes = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          `select public.workspace_email_has_active_member($1, $2) as result`,
          [ws1Id, 'Editor-D@Example.TEST'],
        );
        return res.rows[0].result;
      });
      expect(caseRes).toBe(true);
    });
  });
});
