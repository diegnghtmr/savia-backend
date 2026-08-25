import { afterEach, describe, expect, it } from 'vitest';

import {
  PostgresConfig,
  PostgresConfigurationError,
} from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const databaseUrl = process.env.DATABASE_URL;
const pools: PostgresPool[] = [];

if (process.env.SAVIA_FORCE_POSTGRES_POOL_TEST_FAILURE === '1') {
  throw new Error('Forced postgres-pool harness failure.');
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('PostgresConfig', () => {
  it.each([
    [undefined, {}, 'DATABASE_URL must be configured.'],
    [
      'https://database.example.test',
      {},
      'DATABASE_URL must be a PostgreSQL URL.',
    ],
    [
      'postgresql://postgres:postgres@localhost:5432/postgres',
      { DATABASE_POOL_MAX: '1.5' },
      'DATABASE_POOL_MAX must be an integer.',
    ],
    [
      'postgresql://postgres:postgres@localhost:5432/postgres',
      { DATABASE_POOL_MAX: '0' },
      'DATABASE_POOL_MAX must be greater than zero.',
    ],
    [
      'postgresql://postgres:postgres@localhost:5432/postgres',
      { DATABASE_POOL_MAX: '33' },
      'DATABASE_POOL_MAX must not exceed 32.',
    ],
    [
      'postgresql://postgres:postgres@localhost:5432/postgres',
      { DATABASE_CHECKOUT_TIMEOUT_MS: '1.5' },
      'DATABASE_CHECKOUT_TIMEOUT_MS must be an integer.',
    ],
    [
      'postgresql://postgres:postgres@localhost:5432/postgres',
      { DATABASE_CHECKOUT_TIMEOUT_MS: '0' },
      'DATABASE_CHECKOUT_TIMEOUT_MS must be greater than zero.',
    ],
    [
      'postgresql://postgres:postgres@localhost:5432/postgres',
      { DATABASE_CHECKOUT_TIMEOUT_MS: '10001' },
      'DATABASE_CHECKOUT_TIMEOUT_MS must not exceed 10000.',
    ],
  ])(
    'reports the exact configuration error: %s',
    (url, environment, message) => {
      expect(() => PostgresConfig.fromUrl(url, environment)).toThrowError(
        new PostgresConfigurationError(message),
      );
    },
  );
});

describe('PostgresPool', () => {
  it('rejects an occupied finite pool checkout, then recovers after release', async () => {
    // connectionTimeoutMillis governs both slot contention and initial TCP/auth
    // establishment on an empty pool. Size for the slower operation on loaded CI runners.
    const pool = createPool({
      DATABASE_POOL_MAX: '1',
      DATABASE_CHECKOUT_TIMEOUT_MS: '1000',
    });
    const holder = await pool.connect();
    const started = performance.now();

    await expect(pool.connect()).rejects.toThrow('timeout exceeded');
    expect(performance.now() - started).toBeLessThan(3000);

    holder.release();
    const recovered = await pool.connect();
    await expect(recovered.query('select 1 as ready')).resolves.toMatchObject({
      rows: [{ ready: 1 }],
    });
    recovered.release();
  });

  it('provides a direct client with no transaction marker or Nest activation', async () => {
    const pool = createPool();
    const client = await pool.connect();

    await expect(
      client.query<{ subject: string | null }>(
        "select current_setting('app.subject_id', true) as subject",
      ),
    ).resolves.toMatchObject({ rows: [{ subject: null }] });
    client.release();
  });

  it('rejects acquisition after an awaited shutdown', async () => {
    const pool = createPool();
    const client = await pool.connect();
    client.release();

    await pool.end();
    pools.splice(pools.indexOf(pool), 1);

    await expect(pool.connect()).rejects.toThrow('PostgreSQL pool has ended.');
  });
});

function createPool(overrides: NodeJS.ProcessEnv = {}): PostgresPool {
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required for integration tests.');
  const pool = new PostgresPool(
    PostgresConfig.fromEnvironment({ DATABASE_URL: databaseUrl, ...overrides }),
  );
  pools.push(pool);
  return pool;
}
