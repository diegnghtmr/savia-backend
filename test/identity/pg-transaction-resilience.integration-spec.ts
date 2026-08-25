import { Test } from '@nestjs/testing';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityModule } from '../../src/identity/identity.module.js';
import {
  CommitOutcomeUnknownError,
  PgTransaction,
  TransactionAcquisitionTimeoutError,
  TransactionTimeoutError,
} from '../../src/platform/pg-transaction.js';
import {
  PostgresPool,
  type PgClient,
  type PgPool,
} from '../../src/platform/postgres-pool.js';
import {
  PostgresConfig,
  PostgresConfigurationError,
} from '../../src/platform/postgres-config.js';
const subject = '00000000-0000-0000-0000-000000000301';
const environment = {
  DATABASE_URL: 'postgresql://user:secret@unreachable.invalid:5432/savia',
  JWT_ISSUER: 'https://issuer.example.test',
  JWT_AUDIENCE: 'savia-api',
  JWT_JWKS_URI: 'https://issuer.example.test/jwks',
  JWT_ALGORITHMS: 'RS256',
  DATABASE_CHECKOUT_TIMEOUT_MS: '37',
};
const environmentKeys = Object.keys(environment);
const databaseUrl = process.env.DATABASE_URL;
let originalEnvironment: Record<string, string | undefined>;
if (process.env.SAVIA_MUTATION_PROOF_FILE)
  writeFileSync(process.env.SAVIA_MUTATION_PROOF_FILE, 'vitest-started');
afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});
describe('transaction activation resilience', () => {
  it('preserves deferred checkout configuration through singleton providers', async () => {
    originalEnvironment = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    const module = await Test.createTestingModule({
      imports: [IdentityModule],
    }).compile();
    vi.spyOn(PostgresPool.prototype, 'connect').mockRejectedValueOnce(
      new Error('timeout exceeded when trying to connect'),
    );
    const transaction = module.get(PgTransaction);
    expect(transaction).toBe(module.get(PgTransaction));
    await expect(
      transaction.run(subject, async () => undefined),
    ).rejects.toMatchObject({
      connectionTimeoutMillis: 37,
    });
    await module.close();
  });

  it('physically ends once across concurrent and sequential shutdown delegation', async () => {
    const pool = new PostgresPool({
      connectionString: environment.DATABASE_URL,
      poolMax: 1,
      checkoutTimeoutMs: 10,
    });
    const physicalEnd = vi.fn(async () => undefined);
    (
      pool as unknown as {
        pool: { end(): Promise<void>; connect(): Promise<PgClient> };
      }
    ).pool = {
      end: physicalEnd,
      connect: async () => failurePool(new Error('unused')).connect(),
    };
    const transaction = new PgTransaction(pool);
    await Promise.all([
      transaction.close(),
      transaction.close(),
      transaction.onApplicationShutdown(),
    ]);
    await transaction.close();
    expect(physicalEnd).toHaveBeenCalledTimes(1);
    await expect(pool.connect()).rejects.toThrow('PostgreSQL pool has ended.');
  });
  it('preserves the exact ordinary BEGIN error without rollback or wrapper cause', async () => {
    const failure = new Error('begin failed');
    const pool = failurePool(failure);
    const transaction = new PgTransaction(pool);
    await expect(transaction.run(subject, async () => undefined)).rejects.toBe(
      failure,
    );
    expect(pool.calls).toEqual(['BEGIN']);
    expect(pool.releases).toEqual([failure]);
    expect(failure.cause).toBeUndefined();
  });
  it('wraps timeout-coded BEGIN with the exact cause and no rollback', async () => {
    const failure = Object.assign(new Error('cancelled'), { code: '57014' });
    const pool = failurePool(failure);
    const transaction = new PgTransaction(pool);
    await expect(
      transaction.run(subject, async () => undefined),
    ).rejects.toMatchObject({
      name: 'TransactionTimeoutError',
      cause: failure,
    });
    expect(pool.calls).toEqual(['BEGIN']);
    expect(pool.releases).toEqual([failure]);
  });
  it('redacts every required outer error message while retaining typed causes', async () => {
    const secret = 'postgresql://user:secret@host/savia?subject=hidden';
    const timeout = Object.assign(new Error(secret), { code: '57014' });
    const acquisition = new Error(
      'timeout exceeded when trying to connect ' + secret,
    );
    const cases = [
      PostgresConfig.fromUrl.bind(PostgresConfig, undefined),
      () =>
        new PgTransaction({
          connect: async () => {
            throw acquisition;
          },
          end: async () => undefined,
        }).run(subject, async () => undefined),
      () =>
        new PgTransaction(failurePool(timeout)).run(
          subject,
          async () => undefined,
        ),
      () => Promise.reject(new CommitOutcomeUnknownError(timeout)),
      async () => {
        const pool = new PostgresPool({
          connectionString: secret,
          poolMax: 1,
          checkoutTimeoutMs: 1,
        });
        await pool.end();
        return pool.connect();
      },
    ];
    const errors = await Promise.all(
      cases.map(async (run) => {
        try {
          await run();
        } catch (error) {
          return error as Error;
        }
        throw new Error('Expected failure.');
      }),
    );
    for (const error of errors) expect(error.message).not.toContain(secret);
    expect(errors[0]).toBeInstanceOf(PostgresConfigurationError);
    expect(errors[1]).toMatchObject({
      name: TransactionAcquisitionTimeoutError.name,
      cause: acquisition,
    });
    expect(errors[2]).toMatchObject({
      name: TransactionTimeoutError.name,
      cause: timeout,
    });
    expect(errors[3]).toMatchObject({
      name: CommitOutcomeUnknownError.name,
      cause: timeout,
    });
  });
  it.skipIf(!databaseUrl)(
    'recovers a finite pool after multi-subject callback failures without leaking context',
    async () => {
      const pool = new PostgresPool(
        PostgresConfig.fromEnvironment({
          DATABASE_URL: databaseUrl,
          DATABASE_POOL_MAX: '1',
          DATABASE_CHECKOUT_TIMEOUT_MS: '50',
        }),
      );
      const transaction = new PgTransaction(pool, { checkoutTimeoutMs: 50 });
      for (const suffix of ['302', '303', '304']) {
        await expect(
          transaction.run(
            `00000000-0000-0000-0000-000000000${suffix}`,
            async () => {
              throw new Error('injected callback failure');
            },
          ),
        ).rejects.toThrow('injected callback failure');
      }
      await expect(
        transaction.run(subject, (client) =>
          client.query<{ ready: number }>('select 1 as ready'),
        ),
      ).resolves.toMatchObject({ rows: [{ ready: 1 }] });
      const client = await pool.connect();
      await expect(
        client.query<{ subject: string }>(
          "select current_setting('app.subject_id', true) as subject",
        ),
      ).resolves.toMatchObject({ rows: [{ subject: '' }] });
      client.release();
      await transaction.close();
    },
  );
});
function failurePool(
  failure: Error,
): PgPool & { calls: string[]; releases: (Error | undefined)[] } {
  const calls: string[] = [];
  const releases: (Error | undefined)[] = [];
  const client: PgClient = {
    query: async (text) => {
      calls.push(text);
      throw failure;
    },
    release: (error) => releases.push(error),
  };
  return {
    calls,
    releases,
    connect: async () => client,
    end: async () => undefined,
  };
}
