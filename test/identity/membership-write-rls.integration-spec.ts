// Migrations under test: 202607150011_membership_write_rls.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('Membership write RLS, version column, and column-scoped grants (202607150011_membership_write_rls.sql)', () => {
  let admin: Pool;

  const ownerA = subject(931);
  const ownerB = subject(932);
  const adminC = subject(933);
  const editorD = subject(934);
  const viewerE = subject(935);
  const targetF = subject(936);
  const targetG = subject(937);
  const personalOwnerH = subject(938);
  const suspendedS = subject(939);
  const outsiderZ = subject(940);
  const disposableSubject1 = subject(941);
  const disposableSubject2 = subject(942);
  const disposableSubject3 = subject(943);
  const disposableSubject4 = subject(944);
  const disposableSubject5 = subject(945);

  const ws1Id = '00000000-0000-0000-0000-000000000971';
  const ws2Id = '00000000-0000-0000-0000-000000000972';
  const wsPersonalId = '00000000-0000-0000-0000-000000000973';

  const memOwnerAId = '00000000-0000-0000-0000-000000000981';
  const memOwnerBId = '00000000-0000-0000-0000-000000000982';
  const memAdminCId = '00000000-0000-0000-0000-000000000983';
  const memEditorDId = '00000000-0000-0000-0000-000000000984';
  const memViewerEId = '00000000-0000-0000-0000-000000000985';
  const memTargetFId = '00000000-0000-0000-0000-000000000986';
  const memTargetGId = '00000000-0000-0000-0000-000000000987';
  const memSuspendedSId = '00000000-0000-0000-0000-000000000988';
  const memWs2OwnerAId = '00000000-0000-0000-0000-000000000989';
  const memPersonalOwnerHId = '00000000-0000-0000-0000-000000000990';

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
       ($21, $22), ($23, $24), ($25, $26), ($27, $28), ($29, $30)`,
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
        targetG,
        'target-g@example.test',
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
      [targetG, 'target-g@example.test', 'Target G'],
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
              ($4, $2, $5, 'owner', 'active'),
              ($6, $2, $7, 'administrator', 'active'),
              ($8, $2, $9, 'editor', 'active'),
              ($10, $2, $11, 'viewer', 'active'),
              ($12, $2, $13, 'editor', 'active'),
              ($14, $2, $15, 'viewer', 'active'),
              ($16, $2, $17, 'editor', 'suspended')`,
      [
        memOwnerAId,
        ws1Id,
        ownerA,
        memOwnerBId,
        ownerB,
        memAdminCId,
        adminC,
        memEditorDId,
        editorD,
        memViewerEId,
        viewerE,
        memTargetFId,
        targetF,
        memTargetGId,
        targetG,
        memSuspendedSId,
        suspendedS,
      ],
    );

    // Seed shared workspace W2 (re-point destination for Requirement D)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Shared Workspace 2', 'shared', 'USD', null, $2)`,
      [ws2Id, ownerA],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memWs2OwnerAId, ws2Id, ownerA],
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
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe('version column', () => {
    // NOT covered here: the backfill at 202607150011:3 and the `set constraints all immediate` at :4. The disposable database applies migrations before any membership row exists, so no row is ever backfilled in this harness. Both lines exist for a non-empty production table and are verified by review, not by this suite.
    it('version defaults to 1, is not null, and a direct attempt to set version = 0 is refused by workspace_memberships_version_gte_1 with 23514', async () => {
      const versionRes = await admin.query(
        'select version from public.workspace_memberships where id = $1',
        [memTargetFId],
      );
      expect(versionRes.rows[0].version).toBe(1);

      const columnRes = await admin.query(
        `select is_nullable, column_default
         from information_schema.columns
         where table_name = 'workspace_memberships' and column_name = 'version'`,
      );
      expect(columnRes.rows[0].is_nullable).toBe('NO');
      expect(columnRes.rows[0].column_default).toBe('1');

      await expect(
        admin.query(
          'update public.workspace_memberships set version = 0 where id = $1',
          [memTargetFId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('workspace_actor_active_role', () => {
    it("returns the caller's own active role for a workspace they belong to: owner, administrator, editor and viewer each read back their own role (positive control)", async () => {
      const ownerRole = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(ownerRole).toBe('owner');

      const adminRole = await asSubject(adminC, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(adminRole).toBe('administrator');

      const editorRole = await asSubject(editorD, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(editorRole).toBe('editor');

      const viewerRole = await asSubject(viewerE, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(viewerRole).toBe('viewer');
    });

    it('returns null for a non-member, for a suspended member, and for a workspace that does not exist', async () => {
      const outsiderRole = await asSubject(outsiderZ, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(outsiderRole).toBeNull();

      const suspendedRole = await asSubject(suspendedS, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(suspendedRole).toBeNull();

      const nonExistentWsId = '00000000-0000-0000-0000-000000000999';
      const nonExistentRole = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [nonExistentWsId],
        );
        return res.rows[0].role;
      });
      expect(nonExistentRole).toBeNull();
    });
  });

  describe('42P17 regression — RULING 2 is overturned', () => {
    it('a policy on workspace_memberships that subqueries workspace_memberships raises 42P17 infinite recursion at query time, while workspace_actor_active_role answers the same question (positive control)', async () => {
      try {
        await admin.query(`
          create policy probe_self_referencing_membership
            on public.workspace_memberships
            for select
            to savia_application
            using (
              exists (
                select 1
                from public.workspace_memberships peer
                where peer.workspace_id = workspace_memberships.workspace_id
                  and peer.profile_id = nullif(current_setting('app.subject_id', true), '')::uuid
              )
            );
        `);

        await expect(
          asSubject(ownerA, async (client) => {
            return client.query(
              'select id from public.workspace_memberships where workspace_id = $1',
              [ws1Id],
            );
          }),
        ).rejects.toMatchObject({ code: '42P17' });
      } finally {
        await admin.query(
          'drop policy if exists probe_self_referencing_membership on public.workspace_memberships',
        );
      }

      const positiveControlRole = await asSubject(ownerA, async (client) => {
        const res = await client.query(
          'select public.workspace_actor_active_role($1) as role',
          [ws1Id],
        );
        return res.rows[0].role;
      });
      expect(positiveControlRole).toBe('owner');
    });
  });

  describe('application_reads_administered_membership boundaries', () => {
    it('an editor and a viewer of a shared workspace each read back ONLY their own membership row, while an owner of the same workspace reads back every row (positive control)', async () => {
      const editorRes = await asSubject(editorD, async (client) => {
        return client.query(
          'select id, profile_id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(editorRes.rows).toHaveLength(1);
      expect(editorRes.rows[0].id).toBe(memEditorDId);
      expect(editorRes.rows[0].profile_id).toBe(editorD);

      const viewerRes = await asSubject(viewerE, async (client) => {
        return client.query(
          'select id, profile_id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(viewerRes.rows).toHaveLength(1);
      expect(viewerRes.rows[0].id).toBe(memViewerEId);
      expect(viewerRes.rows[0].profile_id).toBe(viewerE);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          'select id, profile_id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(ownerRes.rows).toHaveLength(8);
      expect(ownerRes.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining([
          memOwnerAId,
          memOwnerBId,
          memAdminCId,
          memEditorDId,
          memViewerEId,
          memTargetFId,
          memTargetGId,
          memSuspendedSId,
        ]),
      );
    });

    it('an owner and an administrator of workspace A read back zero rows from workspace B, while reading back every row of workspace A (positive control)', async () => {
      const ownerWsBRes = await asSubject(ownerB, async (client) => {
        return client.query(
          'select id from public.workspace_memberships where workspace_id = $1',
          [ws2Id],
        );
      });
      expect(ownerWsBRes.rows).toHaveLength(0);

      const ownerWsARes = await asSubject(ownerB, async (client) => {
        return client.query(
          'select id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(ownerWsARes.rows).toHaveLength(8);

      const adminWsBRes = await asSubject(adminC, async (client) => {
        return client.query(
          'select id from public.workspace_memberships where workspace_id = $1',
          [ws2Id],
        );
      });
      expect(adminWsBRes.rows).toHaveLength(0);

      const adminWsARes = await asSubject(adminC, async (client) => {
        return client.query(
          'select id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(adminWsARes.rows).toHaveLength(8);
    });

    it('a SUSPENDED owner and a SUSPENDED administrator each read back zero rows, while the identical query as their active counterpart reads back every row (positive control)', async () => {
      const memSuspendedOwnerId = '00000000-0000-0000-0000-000000000991';
      const memSuspendedAdminId = '00000000-0000-0000-0000-000000000992';

      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'suspended'),
                ($4, $5, $6, 'administrator', 'suspended')`,
        [
          memSuspendedOwnerId,
          ws1Id,
          disposableSubject1,
          memSuspendedAdminId,
          ws1Id,
          disposableSubject2,
        ],
      );

      try {
        const suspendedOwnerRes = await asSubject(
          disposableSubject1,
          async (client) => {
            return client.query(
              'select id from public.workspace_memberships where workspace_id = $1 and profile_id <> $2',
              [ws1Id, disposableSubject1],
            );
          },
        );
        expect(suspendedOwnerRes.rows).toHaveLength(0);

        const activeOwnerRes = await asSubject(ownerA, async (client) => {
          return client.query(
            'select id from public.workspace_memberships where workspace_id = $1 and profile_id <> $2',
            [ws1Id, ownerA],
          );
        });
        expect(activeOwnerRes.rows).toHaveLength(9);

        const suspendedAdminRes = await asSubject(
          disposableSubject2,
          async (client) => {
            return client.query(
              'select id from public.workspace_memberships where workspace_id = $1 and profile_id <> $2',
              [ws1Id, disposableSubject2],
            );
          },
        );
        expect(suspendedAdminRes.rows).toHaveLength(0);

        const activeAdminRes = await asSubject(adminC, async (client) => {
          return client.query(
            'select id from public.workspace_memberships where workspace_id = $1 and profile_id <> $2',
            [ws1Id, adminC],
          );
        });
        expect(activeAdminRes.rows).toHaveLength(9);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id in ($1, $2)',
          [memSuspendedOwnerId, memSuspendedAdminId],
        );
      }
    });

    it('a subject with no membership anywhere reads back zero rows, while an active owner reads back every row (positive control)', async () => {
      const outsiderRes = await asSubject(outsiderZ, async (client) => {
        return client.query(
          'select id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(outsiderRes.rows).toHaveLength(0);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          'select id from public.workspace_memberships where workspace_id = $1',
          [ws1Id],
        );
      });
      expect(ownerRes.rows).toHaveLength(8);
    });
  });

  describe('application_updates_administered_membership', () => {
    it("owner updates a non-owner member's role on a shared workspace -> UPDATE 1 and the row reflects the new role", async () => {
      const updateRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'viewer', version = version + 1 where id = $1`,
          [memTargetFId],
        );
      });
      expect(updateRes.rowCount).toBe(1);

      const check = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memTargetFId],
      );
      expect(check.rows[0].role).toBe('viewer');
      expect(check.rows[0].version).toBe(2);

      // Restore
      await admin.query(
        `update public.workspace_memberships set role = 'editor', version = 1 where id = $1`,
        [memTargetFId],
      );
    });

    it("administrator updates a non-owner member's role -> UPDATE 1 (positive control), while editor and viewer each return UPDATE 0 and leave the row unchanged", async () => {
      const adminRes = await asSubject(adminC, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
          [memTargetGId],
        );
      });
      expect(adminRes.rowCount).toBe(1);

      const checkAdmin = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memTargetGId],
      );
      expect(checkAdmin.rows[0].role).toBe('editor');
      expect(checkAdmin.rows[0].version).toBe(2);

      // Restore before editor/viewer tests
      await admin.query(
        `update public.workspace_memberships set role = 'viewer', version = 1 where id = $1`,
        [memTargetGId],
      );

      const editorRes = await asSubject(editorD, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
          [memTargetGId],
        );
      });
      expect(editorRes.rowCount).toBe(0);

      const checkEditor = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memTargetGId],
      );
      expect(checkEditor.rows[0].role).toBe('viewer');
      expect(checkEditor.rows[0].version).toBe(1);

      const viewerRes = await asSubject(viewerE, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
          [memTargetGId],
        );
      });
      expect(viewerRes.rowCount).toBe(0);

      const checkViewer = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memTargetGId],
      );
      expect(checkViewer.rows[0].role).toBe('viewer');
      expect(checkViewer.rows[0].version).toBe(1);
    });

    it('administrator promoting a member to role owner returns UPDATE 0 and the row is unchanged, while an owner issuing the identical statement succeeds (positive control)', async () => {
      let adminRowCount = 0;
      try {
        const adminRes = await asSubject(adminC, async (client) => {
          return client.query(
            `update public.workspace_memberships set role = 'owner', version = version + 1 where id = $1`,
            [memTargetFId],
          );
        });
        adminRowCount = adminRes.rowCount ?? 0;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42501') throw err;
      }
      expect(adminRowCount).toBe(0);

      const checkAdmin = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memTargetFId],
      );
      expect(checkAdmin.rows[0].role).toBe('editor');
      expect(checkAdmin.rows[0].version).toBe(1);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'owner', version = version + 1 where id = $1`,
          [memTargetFId],
        );
      });
      expect(ownerRes.rowCount).toBe(1);

      const checkOwner = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memTargetFId],
      );
      expect(checkOwner.rows[0].role).toBe('owner');
      expect(checkOwner.rows[0].version).toBe(2);

      // Reset targetF afterwards so later tests see a clean fixture
      await admin.query(
        `update public.workspace_memberships set role = 'editor', version = 1 where id = $1`,
        [memTargetFId],
      );
    });

    it('administrator demoting an existing owner returns UPDATE 0 and the row is unchanged, while an owner issuing the identical statement succeeds (positive control)', async () => {
      const adminRes = await asSubject(adminC, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
          [memOwnerBId],
        );
      });
      expect(adminRes.rowCount).toBe(0);

      const checkAdmin = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memOwnerBId],
      );
      expect(checkAdmin.rows[0].role).toBe('owner');
      expect(checkAdmin.rows[0].version).toBe(1);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
          [memOwnerBId],
        );
      });
      expect(ownerRes.rowCount).toBe(1);

      const checkOwner = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memOwnerBId],
      );
      expect(checkOwner.rows[0].role).toBe('editor');
      expect(checkOwner.rows[0].version).toBe(2);

      // Restore ownerB to owner/active as admin afterwards
      await admin.query(
        `update public.workspace_memberships set role = 'owner', status = 'active', version = 1 where id = $1`,
        [memOwnerBId],
      );
    });

    it('an administrator promoting THEMSELVES to owner returns UPDATE 0 and their row still reads administrator, while an owner promoting that same administrator succeeds (positive control)', async () => {
      let adminRowCount = 0;
      try {
        const adminRes = await asSubject(adminC, async (client) => {
          return client.query(
            `update public.workspace_memberships set role = 'owner' where id = $1`,
            [memAdminCId],
          );
        });
        adminRowCount = adminRes.rowCount ?? 0;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42501') throw err;
      }
      expect(adminRowCount).toBe(0);

      const checkAdmin = await admin.query(
        'select role from public.workspace_memberships where id = $1',
        [memAdminCId],
      );
      expect(checkAdmin.rows[0].role).toBe('administrator');

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'owner' where id = $1`,
          [memAdminCId],
        );
      });
      expect(ownerRes.rowCount).toBe(1);

      const checkOwner = await admin.query(
        'select role from public.workspace_memberships where id = $1',
        [memAdminCId],
      );
      expect(checkOwner.rows[0].role).toBe('owner');

      // Restore adminC afterwards so later tests see a clean fixture
      await admin.query(
        `update public.workspace_memberships set role = 'administrator', version = 1 where id = $1`,
        [memAdminCId],
      );
    });
  });

  describe('application_deletes_administered_membership', () => {
    it('owner deletes a non-owner member on a shared workspace -> DELETE 1 and the row is gone', async () => {
      const disposableMemId = '00000000-0000-0000-0000-000000000995';
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active')`,
        [disposableMemId, ws1Id, disposableSubject1],
      );

      try {
        const deleteRes = await asSubject(ownerA, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [disposableMemId],
          );
        });
        expect(deleteRes.rowCount).toBe(1);

        const check = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [disposableMemId],
        );
        expect(check.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [disposableMemId],
        );
      }
    });

    it('administrator deletes a non-owner member -> DELETE 1 (positive control), while editor and viewer each return DELETE 0 and the row is still present', async () => {
      const disposableMemId1 = '00000000-0000-0000-0000-000000000996';
      const disposableMemId2 = '00000000-0000-0000-0000-000000000997';
      const disposableMemId3 = '00000000-0000-0000-0000-000000000998';

      // Positive control: admin deletes disposableMemId1
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active')`,
        [disposableMemId1, ws1Id, disposableSubject2],
      );
      try {
        const adminRes = await asSubject(adminC, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [disposableMemId1],
          );
        });
        expect(adminRes.rowCount).toBe(1);
        const checkAdmin = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [disposableMemId1],
        );
        expect(checkAdmin.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [disposableMemId1],
        );
      }

      // Negative: editor attempts delete on disposableMemId2
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active')`,
        [disposableMemId2, ws1Id, disposableSubject3],
      );
      try {
        const editorRes = await asSubject(editorD, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [disposableMemId2],
          );
        });
        expect(editorRes.rowCount).toBe(0);
        const checkEditor = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [disposableMemId2],
        );
        expect(checkEditor.rows).toHaveLength(1);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [disposableMemId2],
        );
      }

      // Negative: viewer attempts delete on disposableMemId3
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active')`,
        [disposableMemId3, ws1Id, disposableSubject4],
      );
      try {
        const viewerRes = await asSubject(viewerE, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [disposableMemId3],
          );
        });
        expect(viewerRes.rowCount).toBe(0);
        const checkViewer = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [disposableMemId3],
        );
        expect(checkViewer.rows).toHaveLength(1);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [disposableMemId3],
        );
      }
    });

    it('administrator deleting an owner returns DELETE 0 and the row is still present, while an owner issuing the identical statement succeeds (positive control)', async () => {
      const adminRes = await asSubject(adminC, async (client) => {
        return client.query(
          'delete from public.workspace_memberships where id = $1',
          [memOwnerBId],
        );
      });
      expect(adminRes.rowCount).toBe(0);

      const checkAdmin = await admin.query(
        'select 1 from public.workspace_memberships where id = $1',
        [memOwnerBId],
      );
      expect(checkAdmin.rows).toHaveLength(1);

      const ownerRes = await asSubject(ownerA, async (client) => {
        return client.query(
          'delete from public.workspace_memberships where id = $1',
          [memOwnerBId],
        );
      });
      expect(ownerRes.rowCount).toBe(1);

      const checkOwner = await admin.query(
        'select 1 from public.workspace_memberships where id = $1',
        [memOwnerBId],
      );
      expect(checkOwner.rows).toHaveLength(0);

      // Re-seed ownerB as admin afterwards
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [memOwnerBId, ws1Id, ownerB],
      );
    });
  });

  describe('write boundaries for suspended, cross-workspace and outsider actors', () => {
    it('a SUSPENDED owner and a SUSPENDED administrator each return UPDATE 0 and DELETE 0 and the target row is unchanged, while the identical statements as their active counterpart succeed (positive control)', async () => {
      const memSuspendedOwnerId = '00000000-0000-0000-0000-000000000991';
      const memSuspendedAdminId = '00000000-0000-0000-0000-000000000992';
      const memTargetRowId = '00000000-0000-0000-0000-000000000993';

      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'owner', 'suspended'),
                ($4, $5, $6, 'administrator', 'suspended'),
                ($7, $8, $9, 'viewer', 'active')`,
        [
          memSuspendedOwnerId,
          ws1Id,
          disposableSubject1,
          memSuspendedAdminId,
          ws1Id,
          disposableSubject2,
          memTargetRowId,
          ws1Id,
          disposableSubject3,
        ],
      );

      try {
        // Suspended owner: UPDATE
        let suspendedOwnerUpdateCount = 0;
        try {
          const res = await asSubject(disposableSubject1, async (client) => {
            return client.query(
              `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
              [memTargetRowId],
            );
          });
          suspendedOwnerUpdateCount = res.rowCount ?? 0;
        } catch (err: unknown) {
          if ((err as { code?: string })?.code !== '42501') throw err;
        }
        expect(suspendedOwnerUpdateCount).toBe(0);

        const checkAfterSuspendedOwnerUpdate = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkAfterSuspendedOwnerUpdate.rows[0].role).toBe('viewer');
        expect(checkAfterSuspendedOwnerUpdate.rows[0].version).toBe(1);

        // Suspended owner: DELETE
        const suspendedOwnerDeleteRes = await asSubject(
          disposableSubject1,
          async (client) => {
            return client.query(
              'delete from public.workspace_memberships where id = $1',
              [memTargetRowId],
            );
          },
        );
        expect(suspendedOwnerDeleteRes.rowCount).toBe(0);

        const checkAfterSuspendedOwnerDelete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkAfterSuspendedOwnerDelete.rows).toHaveLength(1);

        // Suspended administrator: UPDATE
        let suspendedAdminUpdateCount = 0;
        try {
          const res = await asSubject(disposableSubject2, async (client) => {
            return client.query(
              `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
              [memTargetRowId],
            );
          });
          suspendedAdminUpdateCount = res.rowCount ?? 0;
        } catch (err: unknown) {
          if ((err as { code?: string })?.code !== '42501') throw err;
        }
        expect(suspendedAdminUpdateCount).toBe(0);

        const checkAfterSuspendedAdminUpdate = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkAfterSuspendedAdminUpdate.rows[0].role).toBe('viewer');
        expect(checkAfterSuspendedAdminUpdate.rows[0].version).toBe(1);

        // Suspended administrator: DELETE
        const suspendedAdminDeleteRes = await asSubject(
          disposableSubject2,
          async (client) => {
            return client.query(
              'delete from public.workspace_memberships where id = $1',
              [memTargetRowId],
            );
          },
        );
        expect(suspendedAdminDeleteRes.rowCount).toBe(0);

        const checkAfterSuspendedAdminDelete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkAfterSuspendedAdminDelete.rows).toHaveLength(1);

        // Positive control: active owner (ownerA) UPDATE
        const activeOwnerUpdateRes = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
            [memTargetRowId],
          );
        });
        expect(activeOwnerUpdateRes.rowCount).toBe(1);

        const checkAfterActiveOwnerUpdate = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkAfterActiveOwnerUpdate.rows[0].role).toBe('editor');
        expect(checkAfterActiveOwnerUpdate.rows[0].version).toBe(2);

        // Positive control: active owner (ownerA) DELETE
        const activeOwnerDeleteRes = await asSubject(ownerA, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [memTargetRowId],
          );
        });
        expect(activeOwnerDeleteRes.rowCount).toBe(1);

        const checkAfterActiveOwnerDelete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkAfterActiveOwnerDelete.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id in ($1, $2, $3)',
          [memSuspendedOwnerId, memSuspendedAdminId, memTargetRowId],
        );
      }
    });

    it('an active owner of workspace A returns UPDATE 0 and DELETE 0 against a membership row of workspace B, while the identical statements against workspace A succeed (positive control)', async () => {
      const memWs2TargetId = '00000000-0000-0000-0000-000000000994';
      const memWs1TargetId = '00000000-0000-0000-0000-000000000995';

      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active'),
                ($4, $5, $6, 'viewer', 'active')`,
        [
          memWs2TargetId,
          ws2Id,
          disposableSubject1,
          memWs1TargetId,
          ws1Id,
          disposableSubject2,
        ],
      );

      try {
        // Negative: ownerB (owner of ws1 only) UPDATE against ws2 target
        let ownerWsBUpdateCount = 0;
        try {
          const res = await asSubject(ownerB, async (client) => {
            return client.query(
              `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
              [memWs2TargetId],
            );
          });
          ownerWsBUpdateCount = res.rowCount ?? 0;
        } catch (err: unknown) {
          if ((err as { code?: string })?.code !== '42501') throw err;
        }
        expect(ownerWsBUpdateCount).toBe(0);

        const checkWs2Update = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memWs2TargetId],
        );
        expect(checkWs2Update.rows[0].role).toBe('viewer');
        expect(checkWs2Update.rows[0].version).toBe(1);

        // Negative: ownerB DELETE against ws2 target
        const ownerWsBDeleteRes = await asSubject(ownerB, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [memWs2TargetId],
          );
        });
        expect(ownerWsBDeleteRes.rowCount).toBe(0);

        const checkWs2Delete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memWs2TargetId],
        );
        expect(checkWs2Delete.rows).toHaveLength(1);

        // Positive control: ownerB UPDATE against ws1 target
        const ownerWsAUpdateRes = await asSubject(ownerB, async (client) => {
          return client.query(
            `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
            [memWs1TargetId],
          );
        });
        expect(ownerWsAUpdateRes.rowCount).toBe(1);

        const checkWs1Update = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memWs1TargetId],
        );
        expect(checkWs1Update.rows[0].role).toBe('editor');
        expect(checkWs1Update.rows[0].version).toBe(2);

        // Positive control: ownerB DELETE against ws1 target
        const ownerWsADeleteRes = await asSubject(ownerB, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [memWs1TargetId],
          );
        });
        expect(ownerWsADeleteRes.rowCount).toBe(1);

        const checkWs1Delete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memWs1TargetId],
        );
        expect(checkWs1Delete.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id in ($1, $2)',
          [memWs2TargetId, memWs1TargetId],
        );
      }
    });

    it('a subject with no membership anywhere returns UPDATE 0 and DELETE 0, while an active owner issuing the identical statements succeeds (positive control)', async () => {
      const memTargetRowId = '00000000-0000-0000-0000-000000000996';

      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active')`,
        [memTargetRowId, ws1Id, disposableSubject1],
      );

      try {
        // Negative: outsiderZ UPDATE
        let outsiderUpdateCount = 0;
        try {
          const res = await asSubject(outsiderZ, async (client) => {
            return client.query(
              `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
              [memTargetRowId],
            );
          });
          outsiderUpdateCount = res.rowCount ?? 0;
        } catch (err: unknown) {
          if ((err as { code?: string })?.code !== '42501') throw err;
        }
        expect(outsiderUpdateCount).toBe(0);

        const checkOutsiderUpdate = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkOutsiderUpdate.rows[0].role).toBe('viewer');
        expect(checkOutsiderUpdate.rows[0].version).toBe(1);

        // Negative: outsiderZ DELETE
        const outsiderDeleteRes = await asSubject(outsiderZ, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [memTargetRowId],
          );
        });
        expect(outsiderDeleteRes.rowCount).toBe(0);

        const checkOutsiderDelete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkOutsiderDelete.rows).toHaveLength(1);

        // Positive control: ownerA UPDATE
        const ownerUpdateRes = await asSubject(ownerA, async (client) => {
          return client.query(
            `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
            [memTargetRowId],
          );
        });
        expect(ownerUpdateRes.rowCount).toBe(1);

        const checkOwnerUpdate = await admin.query(
          'select role, version from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkOwnerUpdate.rows[0].role).toBe('editor');
        expect(checkOwnerUpdate.rows[0].version).toBe(2);

        // Positive control: ownerA DELETE
        const ownerDeleteRes = await asSubject(ownerA, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [memTargetRowId],
          );
        });
        expect(ownerDeleteRes.rowCount).toBe(1);

        const checkOwnerDelete = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
        expect(checkOwnerDelete.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [memTargetRowId],
        );
      }
    });
  });

  describe('personal-workspace exclusion (kind in (family, shared) allow-list)', () => {
    it('owner of a personal workspace updating its sole membership row returns UPDATE 0 and the row is unchanged, while the identical update against a shared workspace succeeds (positive control)', async () => {
      const personalUpdateRes = await asSubject(
        personalOwnerH,
        async (client) => {
          const res = await client.query(
            `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
            [memPersonalOwnerHId],
          );
          expect(res.rowCount).toBe(0);
          return res;
        },
      );
      expect(personalUpdateRes.rowCount).toBe(0);

      const checkPersonal = await admin.query(
        'select role, version from public.workspace_memberships where id = $1',
        [memPersonalOwnerHId],
      );
      expect(checkPersonal.rows[0].role).toBe('owner');
      expect(checkPersonal.rows[0].version).toBe(1);

      // Positive control: identical update against shared workspace W1 (targetF)
      const sharedUpdateRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'editor', version = version + 1 where id = $1`,
          [memTargetFId],
        );
      });
      expect(sharedUpdateRes.rowCount).toBe(1);

      // Restore targetF
      await admin.query(
        `update public.workspace_memberships set role = 'editor', version = 1 where id = $1`,
        [memTargetFId],
      );
    });

    it('owner of a personal workspace deleting its sole membership row returns DELETE 0 and the row is still present, while the identical delete against a shared workspace succeeds (positive control)', async () => {
      const personalDeleteRes = await asSubject(
        personalOwnerH,
        async (client) => {
          const res = await client.query(
            'delete from public.workspace_memberships where id = $1',
            [memPersonalOwnerHId],
          );
          expect(res.rowCount).toBe(0);
          return res;
        },
      );
      expect(personalDeleteRes.rowCount).toBe(0);

      const checkPersonal = await admin.query(
        'select 1 from public.workspace_memberships where id = $1',
        [memPersonalOwnerHId],
      );
      expect(checkPersonal.rows).toHaveLength(1);

      // Positive control: identical delete by ownerA against a disposable non-owner row in W1
      const disposableMemId = '00000000-0000-0000-0000-000000000995';
      await admin.query(
        `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
         values ($1, $2, $3, 'viewer', 'active')`,
        [disposableMemId, ws1Id, disposableSubject5],
      );

      try {
        const sharedDeleteRes = await asSubject(ownerA, async (client) => {
          return client.query(
            'delete from public.workspace_memberships where id = $1',
            [disposableMemId],
          );
        });
        expect(sharedDeleteRes.rowCount).toBe(1);

        const checkShared = await admin.query(
          'select 1 from public.workspace_memberships where id = $1',
          [disposableMemId],
        );
        expect(checkShared.rows).toHaveLength(0);
      } finally {
        await admin.query(
          'delete from public.workspace_memberships where id = $1',
          [disposableMemId],
        );
      }
    });
  });

  describe('Requirement D — column-scoped write surface (grant level, not reachable via HTTP)', () => {
    it('owner attempting to set workspace_id on a membership row is refused with 42501 at GRANT level and the row still belongs to the original workspace', async () => {
      await expect(
        asSubject(ownerA, async (client) => {
          return client.query(
            'update public.workspace_memberships set workspace_id = $1 where id = $2',
            [ws2Id, memTargetFId],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      const check = await admin.query(
        'select workspace_id from public.workspace_memberships where id = $1',
        [memTargetFId],
      );
      expect(check.rows[0].workspace_id).toBe(ws1Id);

      const positiveControlRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'viewer' where id = $1`,
          [memTargetFId],
        );
      });
      expect(positiveControlRes.rowCount).toBe(1);

      // Restore
      await admin.query(
        `update public.workspace_memberships set role = 'editor' where id = $1`,
        [memTargetFId],
      );
    });

    it('owner attempting to set profile_id on a membership row is refused with 42501 at GRANT level and the row still belongs to the original profile', async () => {
      await expect(
        asSubject(ownerA, async (client) => {
          return client.query(
            'update public.workspace_memberships set profile_id = $1 where id = $2',
            [outsiderZ, memTargetFId],
          );
        }),
      ).rejects.toMatchObject({ code: '42501' });

      const check = await admin.query(
        'select profile_id from public.workspace_memberships where id = $1',
        [memTargetFId],
      );
      expect(check.rows[0].profile_id).toBe(targetF);

      const positiveControlRes = await asSubject(ownerA, async (client) => {
        return client.query(
          `update public.workspace_memberships set role = 'viewer' where id = $1`,
          [memTargetFId],
        );
      });
      expect(positiveControlRes.rowCount).toBe(1);

      // Restore
      await admin.query(
        `update public.workspace_memberships set role = 'editor' where id = $1`,
        [memTargetFId],
      );
    });
  });

  describe('savia_elevated privilege narrowing (RULING 13)', () => {
    it('savia_elevated owns workspace_actor_active_role and can select workspace_memberships (positive control) but cannot create tables in schema public, because create was revoked immediately after the ownership transfer', async () => {
      const ownerRes = await admin.query(
        `select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'workspace_actor_active_role'`,
      );
      expect(ownerRes.rows[0]?.owner).toBe('savia_elevated');

      const funcMetaRes = await admin.query(
        `select provolatile, prosecdef from pg_proc where proname = 'workspace_actor_active_role'`,
      );
      expect(funcMetaRes.rows[0]?.provolatile).toBe('s');
      expect(funcMetaRes.rows[0]?.prosecdef).toBe(true);

      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role savia_elevated');

        // Positive control: savia_elevated can select from public.workspace_memberships
        const selectRes = await client.query(
          'select count(*)::int from public.workspace_memberships',
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

    it('the helper is executable by savia_application but NOT by public, and savia_elevated retains no create on schema public (positive control on both)', async () => {
      const publicExecRes = await admin.query(
        `select has_function_privilege('public', 'public.workspace_actor_active_role(uuid)', 'execute') as priv`,
      );
      expect(publicExecRes.rows[0].priv).toBe(false);

      const appExecRes = await admin.query(
        `select has_function_privilege('savia_application', 'public.workspace_actor_active_role(uuid)', 'execute') as priv`,
      );
      expect(appExecRes.rows[0].priv).toBe(true);

      const elevatedCreateRes = await admin.query(
        `select has_schema_privilege('savia_elevated', 'public', 'create') as priv`,
      );
      expect(elevatedCreateRes.rows[0].priv).toBe(false);

      const elevatedUsageRes = await admin.query(
        `select has_schema_privilege('savia_elevated', 'public', 'usage') as priv`,
      );
      expect(elevatedUsageRes.rows[0].priv).toBe(true);
    });
  });
});
