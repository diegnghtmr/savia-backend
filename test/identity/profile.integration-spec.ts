import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTransaction } from '../../src/identity/pg-transaction.js';
import { PostgresProfileAdapter } from '../../src/identity/postgres-profile.adapter.js';
import { PostgresConfig } from '../../src/identity/postgres-config.js';
import { PostgresPool } from '../../src/identity/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('PostgresProfileAdapter database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  const adapter = new PostgresProfileAdapter();

  const subjectA = subject(600);
  const subjectB = subject(601);

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4)`,
      [subjectA, 'subject-a@example.test', subjectB, 'subject-b@example.test'],
    );
    await admin.query(
      `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
       values ($1, 'subject-a@example.test', 'Subject A', 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
      [subjectA],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('returns exactly the six UserProfile keys and no extras under PgTransaction.runRead', async () => {
    const profile = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA),
    );
    expect(profile).toBeDefined();
    expect(Object.keys(profile!).sort()).toEqual(
      [
        'id',
        'email',
        'displayName',
        'locale',
        'timezone',
        'defaultCurrency',
      ].sort(),
    );
  });

  it("subject B's runRead cannot see subject A's row (RLS proof)", async () => {
    const profile = await transaction.runRead(subjectB, (client) =>
      adapter.read(client, subjectA),
    );
    expect(profile).toBeUndefined();
  });

  it("subject A's own row is returned", async () => {
    const profile = await transaction.runRead(subjectA, (client) =>
      adapter.read(client, subjectA),
    );
    expect(profile).toEqual({
      id: subjectA,
      email: 'subject-a@example.test',
      displayName: 'Subject A',
      locale: 'en',
      timezone: 'UTC',
      defaultCurrency: 'USD',
    });
  });

  it('a freshly inserted profile has version = 1 (202607150005_profile_version.sql)', async () => {
    const result = await admin.query<{ version: number }>(
      'select version from public.profiles where id = $1',
      [subjectA],
    );
    expect(result.rows[0]?.version).toBe(1);
  });

  it("savia_application inside PgTransaction.run for subject A can update A's own row and version becomes 2", async () => {
    const updateResult = await transaction.run(subjectA, (client) =>
      client.query(
        `update public.profiles set display_name = 'Subject A Updated', version = version + 1 where id = $1`,
        [subjectA],
      ),
    );
    expect(updateResult.rowCount).toBe(1);

    const result = await admin.query<{ version: number; display_name: string }>(
      'select version, display_name from public.profiles where id = $1',
      [subjectA],
    );
    expect(result.rows[0]?.version).toBe(2);
    expect(result.rows[0]?.display_name).toBe('Subject A Updated');
  });

  it("inside run for subject B, an update targeting A's row affects zero rows (RLS filters)", async () => {
    const before = await admin.query(
      'select * from public.profiles where id = $1',
      [subjectA],
    );
    const updateResult = await transaction.run(subjectB, (client) =>
      client.query(
        `update public.profiles set display_name = 'Subject A Hacked', version = version + 1 where id = $1`,
        [subjectA],
      ),
    );
    expect(updateResult.rowCount).toBe(0);

    const after = await admin.query(
      'select * from public.profiles where id = $1',
      [subjectA],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  // Every case above only proves a row outside the caller's scope is invisible.
  // None proves a visible row cannot be moved OUT of that scope, which is a
  // different guarantee and the one an update policy exists to provide.
  //
  // Measured, because the obvious reading is wrong: deleting `with check` from
  // the policy does NOT break this test. PostgreSQL applies the `using`
  // expression as the check expression when a policy declares no `with check`,
  // and here the two are identical -- so the explicit clause documents intent
  // rather than adding enforcement. What is enforced is verified below.
  //
  // Subject B exists in auth.users and owns no profile row, so moving A's row
  // onto B's id collides with neither the primary key nor the foreign key. The
  // policy is the only thing that can reject it.
  it("subject A cannot move its own row onto another subject's id (with check)", async () => {
    await expect(
      transaction.run(subjectA, (client) =>
        client.query('update public.profiles set id = $2 where id = $1', [
          subjectA,
          subjectB,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const rows = await admin.query(
      'select id from public.profiles where id = $1',
      [subjectB],
    );
    expect(rows.rowCount).toBe(0);
  });
});
