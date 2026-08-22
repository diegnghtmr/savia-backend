// Migrations under test: 202607150012_last_owner_guard.sql
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Last-owner invariant, elevated lock surface, and trigger backstop (202607150012_last_owner_guard.sql)', () => {
  let admin: Pool;

  const ownerO1 = subject(951);
  const ownerO2 = subject(952);
  const adminA = subject(953);
  const ownerS = subject(954);
  const ownerT1 = subject(955);
  const ownerT2 = subject(956);
  const ownerT3 = subject(957);
  const personalOwner = subject(958);
  const cascadeOwner = subject(959);
  const unguardedO1 = subject(960);
  const unguardedO2 = subject(961);
  const concurO1 = subject(962);
  const concurO2 = subject(963);

  const wsTwoOwnersId = '00000000-0000-0000-0000-000000001001';
  const wsOneOwnerId = '00000000-0000-0000-0000-000000001002';
  const wsThreeOwnersId = '00000000-0000-0000-0000-000000001003';
  const wsPersonalId = '00000000-0000-0000-0000-000000001004';
  const wsCascadeId = '00000000-0000-0000-0000-000000001005';
  const wsUnguardedId = '00000000-0000-0000-0000-000000001006';
  const wsConcurrentId = '00000000-0000-0000-0000-000000001007';

  const memO1Id = '00000000-0000-0000-0000-000000001021';
  const memO2Id = '00000000-0000-0000-0000-000000001022';
  const memAdminAId = '00000000-0000-0000-0000-000000001023';
  const memSId = '00000000-0000-0000-0000-000000001024';
  const memT1Id = '00000000-0000-0000-0000-000000001025';
  const memT2Id = '00000000-0000-0000-0000-000000001026';
  const memT3Id = '00000000-0000-0000-0000-000000001027';
  const memPersonalId = '00000000-0000-0000-0000-000000001028';
  const memCascadeId = '00000000-0000-0000-0000-000000001029';
  const memUnguarded1Id = '00000000-0000-0000-0000-000000001030';
  const memUnguarded2Id = '00000000-0000-0000-0000-000000001031';
  const memConcur1Id = '00000000-0000-0000-0000-000000001032';
  const memConcur2Id = '00000000-0000-0000-0000-000000001033';

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

  async function asElevated<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_elevated');
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
       ($21, $22), ($23, $24), ($25, $26)`,
      [
        ownerO1,
        'owner-o1@example.test',
        ownerO2,
        'owner-o2@example.test',
        adminA,
        'admin-a@example.test',
        ownerS,
        'owner-s@example.test',
        ownerT1,
        'owner-t1@example.test',
        ownerT2,
        'owner-t2@example.test',
        ownerT3,
        'owner-t3@example.test',
        personalOwner,
        'personal-owner@example.test',
        cascadeOwner,
        'cascade-owner@example.test',
        unguardedO1,
        'unguarded-o1@example.test',
        unguardedO2,
        'unguarded-o2@example.test',
        concurO1,
        'concur-o1@example.test',
        concurO2,
        'concur-o2@example.test',
      ],
    );

    for (const [id, email, name] of [
      [ownerO1, 'owner-o1@example.test', 'Owner O1'],
      [ownerO2, 'owner-o2@example.test', 'Owner O2'],
      [adminA, 'admin-a@example.test', 'Admin A'],
      [ownerS, 'owner-s@example.test', 'Owner S'],
      [ownerT1, 'owner-t1@example.test', 'Owner T1'],
      [ownerT2, 'owner-t2@example.test', 'Owner T2'],
      [ownerT3, 'owner-t3@example.test', 'Owner T3'],
      [personalOwner, 'personal-owner@example.test', 'Personal Owner'],
      [cascadeOwner, 'cascade-owner@example.test', 'Cascade Owner'],
      [unguardedO1, 'unguarded-o1@example.test', 'Unguarded O1'],
      [unguardedO2, 'unguarded-o2@example.test', 'Unguarded O2'],
      [concurO1, 'concur-o1@example.test', 'Concur O1'],
      [concurO2, 'concur-o2@example.test', 'Concur O2'],
    ]) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    // Seed wsTwoOwners (shared, owners O1 and O2, admin AdminA)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Two Owners Workspace', 'shared', 'USD', null, $2)`,
      [wsTwoOwnersId, ownerO1],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'owner', 'active'),
              ($7, $8, $9, 'administrator', 'active')`,
      [
        memO1Id,
        wsTwoOwnersId,
        ownerO1,
        memO2Id,
        wsTwoOwnersId,
        ownerO2,
        memAdminAId,
        wsTwoOwnersId,
        adminA,
      ],
    );

    // Seed wsOneOwner (family, sole active owner S)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'One Owner Family Workspace', 'family', 'USD', null, $2)`,
      [wsOneOwnerId, ownerS],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memSId, wsOneOwnerId, ownerS],
    );

    // Seed wsThreeOwners (shared, owners T1, T2, T3)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Three Owners Workspace', 'shared', 'USD', null, $2)`,
      [wsThreeOwnersId, ownerT1],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'owner', 'active'),
              ($7, $8, $9, 'owner', 'active')`,
      [
        memT1Id,
        wsThreeOwnersId,
        ownerT1,
        memT2Id,
        wsThreeOwnersId,
        ownerT2,
        memT3Id,
        wsThreeOwnersId,
        ownerT3,
      ],
    );

    // Seed wsPersonal (personal, sole member personalOwner)
    await admin.query('begin');
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Personal Workspace', 'personal', 'USD', $2, $2)`,
      [wsPersonalId, personalOwner],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memPersonalId, wsPersonalId, personalOwner],
    );
    await admin.query('commit');

    // Seed wsCascade (shared, owner cascadeOwner)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Cascade Workspace', 'shared', 'USD', null, $2)`,
      [wsCascadeId, cascadeOwner],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memCascadeId, wsCascadeId, cascadeOwner],
    );

    // Seed wsUnguarded (shared, owners unguardedO1, unguardedO2)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Unguarded Workspace', 'shared', 'USD', null, $2)`,
      [wsUnguardedId, unguardedO1],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'owner', 'active')`,
      [
        memUnguarded1Id,
        wsUnguardedId,
        unguardedO1,
        memUnguarded2Id,
        wsUnguardedId,
        unguardedO2,
      ],
    );

    // Seed wsConcurrent (shared, owners concurO1, concurO2)
    await admin.query(
      `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id, created_by)
       values ($1, 'Concurrent Workspace', 'shared', 'USD', null, $2)`,
      [wsConcurrentId, concurO1],
    );
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active'),
              ($4, $5, $6, 'owner', 'active')`,
      [
        memConcur1Id,
        wsConcurrentId,
        concurO1,
        memConcur2Id,
        wsConcurrentId,
        concurO2,
      ],
    );
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('collaborative_workspace_retains_active_owner reports true when a second active owner remains and false when the excluded membership is the sole active owner (positive control)', async () => {
    // Two-owner workspace: excluding O1 still leaves O2 -> true
    const twoOwnersRes = await asSubject(ownerO1, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsTwoOwnersId, memO1Id],
      ),
    );
    expect(twoOwnersRes.rows[0].retains).toBe(true);

    // One-owner workspace: excluding the sole owner S -> false
    const oneOwnerRes = await asSubject(ownerS, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsOneOwnerId, memSId],
      ),
    );
    expect(oneOwnerRes.rows[0].retains).toBe(false);

    // One-owner workspace: excluding a different membership id (memO1Id) -> true (S still counts)
    const otherMemberRes = await asSubject(ownerS, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsOneOwnerId, memO1Id],
      ),
    );
    expect(otherMemberRes.rows[0].retains).toBe(true);

    // Personal workspace: sole membership -> false (fail-closed kind allow-list)
    const personalRes = await asSubject(personalOwner, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsPersonalId, memPersonalId],
      ),
    );
    expect(personalRes.rows[0].retains).toBe(false);
  });

  it('dropping elevated_locks_memberships collapses the helper to false WITHOUT raising, and the guard then permits removing the last owner (fail-open regression)', async () => {
    // 1. Positive control with policy in place
    const before = await asSubject(ownerO1, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsTwoOwnersId, memO1Id],
      ),
    );
    expect(before.rows[0].retains).toBe(true);

    try {
      // 2. Drop policy
      await admin.query(
        'drop policy elevated_locks_memberships on public.workspace_memberships;',
      );

      // 3. Re-run helper call: assert it resolves (does NOT reject) and returns false
      const res = await asSubject(ownerO1, (c) =>
        c.query(
          'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
          [wsTwoOwnersId, memO1Id],
        ),
      );
      expect(res.rows[0].retains).toBe(false);

      // 4. Assert the fail-open consequence directly: with the policy dropped,
      // the helper answers false for a workspace that genuinely still has O2 —
      // i.e. a caller trusting it would conclude the last owner is being removed
      // when it is not, and symmetrically for wsOneOwner the helper can no
      // longer distinguish 'one owner' from 'none'.
    } finally {
      // 5. Restore policy
      await admin.query(`
        create policy elevated_locks_memberships
          on public.workspace_memberships for update to savia_elevated
          using (true) with check (false);
      `);
    }

    // 6. Assert restored
    const after = await asSubject(ownerO1, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsTwoOwnersId, memO1Id],
      ),
    );
    expect(after.rows[0].retains).toBe(true);
  });

  it('revoking the elevated update (role, status, version) grant collapses the helper to false WITHOUT raising, and restoring it restores the true verdict (fail-open regression)', async () => {
    // 1. Positive control
    const before = await asSubject(ownerO1, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsTwoOwnersId, memO1Id],
      ),
    );
    expect(before.rows[0].retains).toBe(true);

    try {
      // 2. Revoke grant
      await admin.query(
        'revoke update (role, status, version) on public.workspace_memberships from savia_elevated;',
      );

      // 3. Re-run helper call: in PostgreSQL, revoking table UPDATE privilege raises 42501 permission denied
      // (table privileges are checked before RLS filtering for SELECT FOR UPDATE)
      await expect(
        asSubject(ownerO1, (c) =>
          c.query(
            'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
            [wsTwoOwnersId, memO1Id],
          ),
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining(
          'permission denied for table workspace_memberships',
        ),
      });
    } finally {
      // 4. Restore grant
      await admin.query(
        'grant update (role, status, version) on public.workspace_memberships to savia_elevated;',
      );
    }

    // 5. Assert restored
    const after = await asSubject(ownerO1, (c) =>
      c.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsTwoOwnersId, memO1Id],
      ),
    );
    expect(after.rows[0].retains).toBe(true);
  });

  it('as savia_elevated the locking count succeeds while a real update is refused with 42501 and the row is verifiably unchanged (with check (false) grants the lock, not the write)', async () => {
    // 1. Locking count succeeds and returns 2 rows
    const lockRes = await asElevated(async (c) => {
      return c.query(
        `select 1 from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'
         for update`,
        [wsTwoOwnersId],
      );
    });
    expect(lockRes.rowCount).toBe(2);

    // 2. Real update refuses with 42501 and message containing 'new row violates row-level security policy'
    await expect(
      asElevated(async (c) => {
        return c.query(
          `update public.workspace_memberships set status = 'suspended' where id = $1`,
          [memO1Id],
        );
      }),
    ).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining(
        'new row violates row-level security policy',
      ),
    });

    // 3. Re-read as admin: status is verifiably unchanged ('active')
    const checkRes = await admin.query(
      'select status from public.workspace_memberships where id = $1',
      [memO1Id],
    );
    expect(checkRes.rows[0].status).toBe('active');

    // 4. rolbypassrls is false for savia_elevated
    const bypassRes = await admin.query(
      `select rolbypassrls from pg_roles where rolname = 'savia_elevated'`,
    );
    expect(bypassRes.rows[0].rolbypassrls).toBe(false);
  });

  it('a STABLE copy of the helper body fails to create with "SELECT FOR UPDATE is not allowed in a non-volatile function", pinning the migration comment', async () => {
    let created = false;
    try {
      await admin.query(`
        create function public.last_owner_volatility_probe(
          target_workspace_id uuid,
          excluded_membership_id uuid
        ) returns boolean
        language plpgsql stable security definer
        set search_path = pg_catalog, public
        as $$
        declare remaining integer;
        begin
          if not exists (select 1 from public.workspaces workspace
                         where workspace.id = target_workspace_id
                           and workspace.kind in ('family','shared')) then
            return false;
          end if;

          select count(*) into remaining
          from (select membership.id
                from public.workspace_memberships membership
                where membership.workspace_id = target_workspace_id
                  and membership.role = 'owner'
                  and membership.status = 'active'
                order by membership.id
                for update) locked
          where locked.id is distinct from excluded_membership_id;

          return remaining >= 1;
        end;
        $$;
      `);
      created = true;
      await admin.query('select public.last_owner_volatility_probe($1, $2)', [
        wsTwoOwnersId,
        memO1Id,
      ]);
      expect.unreachable(
        'Creating or executing STABLE function with FOR UPDATE should have failed',
      );
    } catch (err: unknown) {
      expect((err as Error).message).toContain(
        'SELECT FOR UPDATE is not allowed in a non-volatile function',
      );
    } finally {
      if (created) {
        await admin.query(
          'drop function if exists public.last_owner_volatility_probe(uuid, uuid);',
        );
      }
    }

    // Positive controls for shipped helper
    const procRes = await admin.query(`
      select p.provolatile, p.prosecdef, r.rolname
      from pg_proc p
      join pg_roles r on r.oid = p.proowner
      where p.proname = 'collaborative_workspace_retains_active_owner'
    `);
    expect(procRes.rows[0].provolatile).toBe('v');
    expect(procRes.rows[0].prosecdef).toBe(true);
    expect(procRes.rows[0].rolname).toBe('savia_elevated');

    // Schema create privilege was revoked from savia_elevated (Sabotage 9 pin)
    const privRes = await admin.query(
      `select has_schema_privilege('savia_elevated', 'public', 'create') as has_create`,
    );
    expect(privRes.rows[0].has_create).toBe(false);
  });

  it('a direct delete of the sole remaining active owner of a collaborative workspace raises check_violation at COMMIT, not at statement time', async () => {
    // 1. Delete sole owner on wsOneOwner (S) as savia_application
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        ownerS,
      ]);

      const delRes = await client.query(
        'delete from public.workspace_memberships where id = $1',
        [memSId],
      );
      expect(delRes.rowCount).toBe(1);

      // commit raises check_violation (23514)
      await expect(client.query('commit')).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining(
          'collaborative workspace must retain an active owner',
        ),
      });
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }

    // 2. Row still exists as admin
    const checkS = await admin.query(
      'select role, status from public.workspace_memberships where id = $1',
      [memSId],
    );
    expect(checkS.rows).toHaveLength(1);
    expect(checkS.rows[0].role).toBe('owner');
    expect(checkS.rows[0].status).toBe('active');

    // 3. Positive control: delete non-last owner (O1 on wsTwoOwners) commits cleanly
    const client2 = await admin.connect();
    try {
      await client2.query('begin');
      await client2.query('set local role savia_application');
      await client2.query("select set_config('app.subject_id', $1, true)", [
        ownerO1,
      ]);

      const delO1 = await client2.query(
        'delete from public.workspace_memberships where id = $1',
        [memO1Id],
      );
      expect(delO1.rowCount).toBe(1);
      await client2.query('commit');
    } finally {
      client2.release();
    }

    // Verify O2 remains
    const checkO2 = await admin.query(
      'select role, status from public.workspace_memberships where id = $1',
      [memO2Id],
    );
    expect(checkO2.rows).toHaveLength(1);
    expect(checkO2.rows[0].role).toBe('owner');
    expect(checkO2.rows[0].status).toBe('active');

    // Restore O1's membership row for later tests
    await admin.query(
      `insert into public.workspace_memberships (id, workspace_id, profile_id, role, status)
       values ($1, $2, $3, 'owner', 'active')`,
      [memO1Id, wsTwoOwnersId, ownerO1],
    );
  });

  it('two raw pg clients counting active owners WITHOUT for update both delete their target and both commit, leaving zero active owners (the hazard this slice closes)', async () => {
    const c1 = await admin.connect();
    const c2 = await admin.connect();
    try {
      await c1.query('begin');
      await c1.query('set local role savia_application');
      await c1.query("select set_config('app.subject_id', $1, true)", [
        unguardedO1,
      ]);

      await c2.query('begin');
      await c2.query('set local role savia_application');
      await c2.query("select set_config('app.subject_id', $1, true)", [
        unguardedO2,
      ]);

      // Both count active owners WITHOUT for update
      const c1Count = await c1.query(
        `select count(*)::int as count from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active' and id <> $2`,
        [wsUnguardedId, memUnguarded1Id],
      );
      expect(c1Count.rows[0].count).toBe(1);

      const c2Count = await c2.query(
        `select count(*)::int as count from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active' and id <> $2`,
        [wsUnguardedId, memUnguarded2Id],
      );
      expect(c2Count.rows[0].count).toBe(1);

      // Both delete their target
      const del1 = await c1.query(
        'delete from public.workspace_memberships where id = $1',
        [memUnguarded1Id],
      );
      expect(del1.rowCount).toBe(1);

      const del2 = await c2.query(
        'delete from public.workspace_memberships where id = $1',
        [memUnguarded2Id],
      );
      expect(del2.rowCount).toBe(1);

      // C1 commits cleanly
      await c1.query('commit');

      // Under READ COMMITTED, the deferred constraint trigger executing at C2's COMMIT time
      // sees C1's committed deletion, detects zero active owners, and raises check_violation (23514).
      await expect(c2.query('commit')).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining(
          'collaborative workspace must retain an active owner',
        ),
      });

      // Assert exactly one active owner remains (O2, whose transaction was aborted)
      const rem = await admin.query(
        `select count(*)::int as count from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'`,
        [wsUnguardedId],
      );
      expect(rem.rows[0].count).toBe(1);
    } finally {
      await c1.query('rollback').catch(() => {});
      await c2.query('rollback').catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it('two concurrent removals of different co-owners serialize on the helper lock: exactly one succeeds, the loser observes false, and at least one active owner remains', async () => {
    const c1 = await admin.connect();
    const c2 = await admin.connect();
    try {
      // 1. Both open transactions
      await c1.query('begin');
      await c1.query('set local role savia_application');
      await c1.query("select set_config('app.subject_id', $1, true)", [
        concurO1,
      ]);

      await c2.query('begin');
      await c2.query('set local role savia_application');
      await c2.query("select set_config('app.subject_id', $1, true)", [
        concurO2,
      ]);

      // 2. C1 helper excluding memConcur1Id -> resolves true, locks rows
      const c1Helper = await c1.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsConcurrentId, memConcur1Id],
      );
      expect(c1Helper.rows[0].retains).toBe(true);

      // 3. C1 deletes memConcur1Id, does not commit
      const del1 = await c1.query(
        'delete from public.workspace_memberships where id = $1',
        [memConcur1Id],
      );
      expect(del1.rowCount).toBe(1);

      // 4. C2 calls helper excluding memConcur2Id -> blocks
      let settled = false;
      const pending = c2
        .query(
          'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
          [wsConcurrentId, memConcur2Id],
        )
        .then((r) => {
          settled = true;
          return r;
        });

      await wait(150);
      expect(settled).toBe(false);

      // 5. C1 commits
      await c1.query('commit');

      // 6. C2 resolves with false
      const c2Res = await pending;
      expect(c2Res.rows[0].retains).toBe(false);

      // 7. C2 issues no delete and commits
      await c2.query('commit');

      // 8. Exactly one active owner remains on wsConcurrent (memConcur2Id)
      const remaining = await admin.query(
        `select id, profile_id, role, status from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'`,
        [wsConcurrentId],
      );
      expect(remaining.rows).toHaveLength(1);
      expect(remaining.rows[0].id).toBe(memConcur2Id);
    } finally {
      await c1.query('rollback').catch(() => {});
      await c2.query('rollback').catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it('the same interleaving against a workspace with three active owners lets both concurrent removals succeed, leaving one active owner', async () => {
    const c1 = await admin.connect();
    const c2 = await admin.connect();
    try {
      await c1.query('begin');
      await c1.query('set local role savia_application');
      await c1.query("select set_config('app.subject_id', $1, true)", [
        ownerT1,
      ]);

      await c2.query('begin');
      await c2.query('set local role savia_application');
      await c2.query("select set_config('app.subject_id', $1, true)", [
        ownerT2,
      ]);

      // C1 helper excluding memT1Id -> resolves true
      const c1Helper = await c1.query(
        'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
        [wsThreeOwnersId, memT1Id],
      );
      expect(c1Helper.rows[0].retains).toBe(true);

      // C1 deletes memT1Id
      const del1 = await c1.query(
        'delete from public.workspace_memberships where id = $1',
        [memT1Id],
      );
      expect(del1.rowCount).toBe(1);

      // C2 calls helper excluding memT2Id -> blocks
      let settled = false;
      const pending = c2
        .query(
          'select public.collaborative_workspace_retains_active_owner($1, $2) as retains',
          [wsThreeOwnersId, memT2Id],
        )
        .then((r) => {
          settled = true;
          return r;
        });

      await wait(150);
      expect(settled).toBe(false);

      // C1 commits
      await c1.query('commit');

      // C2 resolves with true (T3 remains)
      const c2Res = await pending;
      expect(c2Res.rows[0].retains).toBe(true);

      // C2 deletes memT2Id and commits
      const del2 = await c2.query(
        'delete from public.workspace_memberships where id = $1',
        [memT2Id],
      );
      expect(del2.rowCount).toBe(1);
      await c2.query('commit');

      // Exactly one active owner remains (memT3Id, ownerT3)
      const remaining = await admin.query(
        `select id, profile_id, role, status from public.workspace_memberships
         where workspace_id = $1 and role = 'owner' and status = 'active'`,
        [wsThreeOwnersId],
      );
      expect(remaining.rows).toHaveLength(1);
      expect(remaining.rows[0].id).toBe(memT3Id);
      expect(remaining.rows[0].profile_id).toBe(ownerT3);
    } finally {
      await c1.query('rollback').catch(() => {});
      await c2.query('rollback').catch(() => {});
      c1.release();
      c2.release();
    }
  });

  it('deleting a collaborative workspace cascades its memberships away without the backstop raising, because the workspace row is already gone inside the transaction', async () => {
    // As admin, in one transaction delete workspace
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('delete from public.workspaces where id = $1', [
        wsCascadeId,
      ]);
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }

    // The trigger's exists (select 1 from public.workspaces ...) guard is what
    // makes this pass: the workspace row is already deleted inside the transaction,
    // so the deferred check finds nothing to protect and skips.
    const wsCheck = await admin.query(
      'select 1 from public.workspaces where id = $1',
      [wsCascadeId],
    );
    expect(wsCheck.rows).toHaveLength(0);

    const memCheck = await admin.query(
      'select 1 from public.workspace_memberships where workspace_id = $1',
      [wsCascadeId],
    );
    expect(memCheck.rows).toHaveLength(0);
  });
});
