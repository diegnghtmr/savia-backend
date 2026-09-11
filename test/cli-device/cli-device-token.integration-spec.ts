// Migrations under test: 202609060011_cli_device_token.sql, 202609100012_cli_device_approval.sql
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

describe('CLI device token database capability', () => {
  let pool: Pool;
  const subject = '00000000-0000-0000-0000-000000000201';
  const otherSubject = '00000000-0000-0000-0000-000000000202';
  const clientId = 'integration-cli-token';
  const deviceCodeHash = createHash('sha256')
    .update('device-code')
    .digest('hex');

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(
      `
      insert into auth.users (id, email) values ($1, $2), ($3, $4)
      on conflict (id) do nothing`,
      [
        subject,
        'cli-token@example.test',
        otherSubject,
        'cli-token-other@example.test',
      ],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  async function createAuthorization(expiresAt: string) {
    await pool.query(
      `insert into public.cli_device_authorizations
       (device_code_hash, user_code, client_id, expires_at) values ($1, $2, $3, $4)`,
      [deviceCodeHash, 'ABCD2345', clientId, expiresAt],
    );
  }

  it('allows only an authenticated subject to approve a pending unexpired code', async () => {
    await createAuthorization('2999-01-01T00:00:00Z');
    const unrelatedHash = createHash('sha256')
      .update('unrelated-device')
      .digest('hex');
    await pool.query(
      `insert into public.cli_device_authorizations
       (device_code_hash, user_code, client_id, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')`,
      [unrelatedHash, 'EFGH2345', clientId],
    );
    const direct = await pool.connect();
    try {
      await direct.query('begin');
      await direct.query('set local role savia_application');
      await direct.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      await expect(
        direct.query(
          `update public.cli_device_authorizations
           set approved_at = now(), approved_by_subject_id = $1
           where user_code = $2`,
          [subject, 'EFGH2345'],
        ),
      ).rejects.toThrow();
      await direct.query('rollback');
    } finally {
      direct.release();
    }
    const mismatched = await pool.connect();
    try {
      await mismatched.query('begin');
      await mismatched.query('set local role savia_application');
      await mismatched.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      await expect(
        mismatched.query(
          `update public.cli_device_authorizations
           set approved_at = now(), approved_by_subject_id = $1
           where user_code = $2`,
          [otherSubject, 'ABCD2345'],
        ),
      ).rejects.toThrow();
      await mismatched.query('rollback');
    } finally {
      mismatched.release();
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      await client.query('select public.approve_cli_device_authorization($1)', [
        'ABCD2345',
      ]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const row = await pool.query<{ approved_by_subject_id: string }>(
      'select approved_by_subject_id from public.cli_device_authorizations where device_code_hash = $1',
      [deviceCodeHash],
    );
    expect(row.rows[0]?.approved_by_subject_id).toBe(subject);
    const other = await pool.connect();
    try {
      await other.query('begin');
      await other.query('set local role savia_application');
      await other.query("select set_config('app.subject_id', $1, true)", [
        otherSubject,
      ]);
      const rejected = await other.query<{ approved: boolean }>(
        'select public.approve_cli_device_authorization($1) as approved',
        ['ABCD2345'],
      );
      expect(rejected.rows[0]?.approved).toBe(false);
      await other.query('commit');
    } finally {
      other.release();
    }
  });

  it('rejects unauthenticated approval and repeat approval', async () => {
    await pool.query(
      'delete from public.cli_device_authorizations where device_code_hash = $1',
      [deviceCodeHash],
    );
    await createAuthorization('2999-01-01T00:00:00Z');
    const unauthenticated = await pool.connect();
    try {
      await unauthenticated.query('begin');
      await unauthenticated.query('set local role savia_application');
      await expect(
        unauthenticated.query(
          'select public.approve_cli_device_authorization($1)',
          ['ABCD2345'],
        ),
      ).rejects.toThrow();
      await unauthenticated.query('rollback');
    } finally {
      unauthenticated.release();
    }
    const authenticated = await pool.connect();
    try {
      await authenticated.query('begin');
      await authenticated.query('set local role savia_application');
      await authenticated.query(
        "select set_config('app.subject_id', $1, true)",
        [subject],
      );
      const approved = await authenticated.query<{ approved: boolean }>(
        'select public.approve_cli_device_authorization($1) as approved',
        ['ABCD2345'],
      );
      expect(approved.rows[0]?.approved).toBe(true);
      const second = await authenticated.query<{ approved: boolean }>(
        'select public.approve_cli_device_authorization($1) as approved',
        ['ABCD2345'],
      );
      expect(second.rows[0]?.approved).toBe(true);
      await authenticated.query('commit');
    } finally {
      authenticated.release();
    }
  });

  it('atomically redeems a code once and checks token revocation at verification time', async () => {
    const first = await pool.query(
      'select * from public.redeem_cli_device_authorization($1, $2, now())',
      [deviceCodeHash, clientId],
    );
    const second = await pool.query(
      'select * from public.redeem_cli_device_authorization($1, $2, now())',
      [deviceCodeHash, clientId],
    );
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
    const tokenHash = createHash('sha256').update('opaque-token').digest('hex');
    const expiresAt = first.rows[0]?.expires_at;
    await pool.query(
      'select public.insert_cli_device_token($1, $2, $3, $4, $5)',
      [tokenHash, subject, deviceCodeHash, first.rows[0]?.scopes, expiresAt],
    );
    const active = await pool.query(
      'select * from public.verify_cli_device_token($1)',
      [tokenHash],
    );
    expect(active.rows).toHaveLength(1);
    await pool.query(
      "update public.cli_device_tokens set status = 'revoked' where token_hash = $1",
      [tokenHash],
    );
    const revoked = await pool.query(
      'select * from public.verify_cli_device_token($1)',
      [tokenHash],
    );
    expect(revoked.rows).toHaveLength(0);
  });

  it('rejects approval at and beyond expiry while accepting an unexpired row', async () => {
    const pastHash = createHash('sha256').update('past-device').digest('hex');
    const futureHash = createHash('sha256')
      .update('future-device')
      .digest('hex');
    await pool.query(
      `insert into public.cli_device_authorizations
       (device_code_hash, user_code, client_id, created_at, expires_at)
       values ($1, $2, $3, now() - interval '2 seconds', now() - interval '1 second'),
              ($4, $5, $3, now(), now() + interval '10 minutes')`,
      [pastHash, 'PAST2345', clientId, futureHash, 'FUTR2345'],
    );
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      const past = await client.query(
        'select public.approve_cli_device_authorization($1) as approved',
        ['PAST2345'],
      );
      const future = await client.query(
        'select public.approve_cli_device_authorization($1) as approved',
        ['FUTR2345'],
      );
      expect(past.rows[0]?.approved).toBe(false);
      expect(future.rows[0]?.approved).toBe(true);
      await client.query('commit');
    } finally {
      client.release();
    }
  });

  it('does not verify an expired token', async () => {
    const expiredHash = createHash('sha256')
      .update('expired-token')
      .digest('hex');
    await pool.query(
      `insert into public.cli_device_tokens
       (token_hash, subject_id, device_code_hash, scopes, created_at, expires_at)
       values ($1, $2, $3, $4, now() - interval '2 seconds', now() - interval '1 second')`,
      [expiredHash, subject, deviceCodeHash, []],
    );
    const result = await pool.query(
      'select * from public.verify_cli_device_token($1)',
      [expiredHash],
    );
    expect(result.rows).toHaveLength(0);
  });

  it('keeps authorization rows unreadable to the pooled application role and binds approval in the policy', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      try {
        await expect(
          client.query('select * from public.cli_device_authorizations'),
        ).rejects.toThrow();
      } finally {
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
    const policies = await pool.query<{ with_check: string }>(
      `select with_check from pg_policies
       where schemaname = 'public' and tablename = 'cli_device_authorizations'
       and policyname = 'cli_device_authorizations_approve'`,
    );
    expect(policies.rows[0]?.with_check).toContain('approved_by_subject_id');
    expect(policies.rows[0]?.with_check).toContain('app.subject_id');
  });

  it('limits approval to ten calls per UTC minute and commits invalid outcomes', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      const results = [];
      for (let attempt = 0; attempt < 11; attempt++) {
        const result = await client.query<{ allowed: boolean }>(
          `select public.consume_cli_device_approval_rate_limit(
            '1900-01-01T00:00:30Z'::timestamptz
          ) as allowed`,
        );
        results.push(result.rows[0]?.allowed);
      }
      expect(results.slice(0, 10).every(Boolean)).toBe(true);
      expect(results[10]).toBe(false);
      await client.query('commit');
    } finally {
      client.release();
    }
    const row = await pool.query<{ request_count: number }>(
      `select request_count from public.cli_device_approval_rate_limits
       where subject_id = $1 and window_start = '1900-01-01T00:00:00Z'::timestamptz`,
      [subject],
    );
    expect(row.rows[0]?.request_count).toBe(11);
  });

  it('refuses direct approval and redemption updates by the pooled application role', async () => {
    const directUpdateHash = createHash('sha256')
      .update('direct-update-device')
      .digest('hex');
    await pool.query(
      'delete from public.cli_device_authorizations where device_code_hash = $1',
      [directUpdateHash],
    );
    await pool.query(
      `insert into public.cli_device_authorizations
       (device_code_hash, user_code, client_id, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')`,
      [directUpdateHash, 'UPDT2345', clientId],
    );

    const approval = await pool.connect();
    try {
      await approval.query('begin');
      await approval.query('set local role savia_application');
      await approval.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      await expect(
        approval.query(
          `update public.cli_device_authorizations
           set approved_at = now(), approved_by_subject_id = $1`,
          [subject],
        ),
      ).rejects.toThrow();
      await approval.query('rollback');
    } finally {
      approval.release();
    }

    const afterApproval = await pool.query<{
      approved_at: string | null;
      approved_by_subject_id: string | null;
    }>(
      `select approved_at, approved_by_subject_id
       from public.cli_device_authorizations where device_code_hash = $1`,
      [directUpdateHash],
    );
    expect(afterApproval.rows[0]?.approved_at).toBeNull();
    expect(afterApproval.rows[0]?.approved_by_subject_id).toBeNull();

    const redemption = await pool.connect();
    try {
      await redemption.query('begin');
      await redemption.query('set local role savia_application');
      await redemption.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      await expect(
        redemption.query(
          `update public.cli_device_authorizations
           set redeemed_at = now()`,
        ),
      ).rejects.toThrow();
      await redemption.query('rollback');
    } finally {
      redemption.release();
    }

    const afterRedemption = await pool.query<{ redeemed_at: string | null }>(
      'select redeemed_at from public.cli_device_authorizations where device_code_hash = $1',
      [directUpdateHash],
    );
    expect(afterRedemption.rows[0]?.redeemed_at).toBeNull();
  });

  it('allows only one of two concurrent redemptions', async () => {
    const concurrentHash = createHash('sha256')
      .update('concurrent-device')
      .digest('hex');
    await pool.query(
      `insert into public.cli_device_authorizations
       (device_code_hash, user_code, client_id, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')`,
      [concurrentHash, 'ABCD2346', clientId],
    );
    const approval = await pool.connect();
    try {
      await approval.query('begin');
      await approval.query('set local role savia_application');
      await approval.query("select set_config('app.subject_id', $1, true)", [
        subject,
      ]);
      await approval.query(
        'select public.approve_cli_device_authorization($1)',
        ['ABCD2346'],
      );
      await approval.query('commit');
    } finally {
      approval.release();
    }
    const results = await Promise.all([
      pool.query(
        'select * from public.redeem_cli_device_authorization($1, $2, now())',
        [concurrentHash, clientId],
      ),
      pool.query(
        'select * from public.redeem_cli_device_authorization($1, $2, now())',
        [concurrentHash, clientId],
      ),
    ]);
    expect(results.filter(({ rows }) => rows.length === 1)).toHaveLength(1);
    expect(results.filter(({ rows }) => rows.length === 0)).toHaveLength(1);
  });
});
