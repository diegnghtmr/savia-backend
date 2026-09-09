// Migration under test: 202609060011_cli_device_token.sql
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
  });
});
