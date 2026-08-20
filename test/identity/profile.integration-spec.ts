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
});
