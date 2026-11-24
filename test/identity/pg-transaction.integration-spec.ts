import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CommitOutcomeUnknownError,
  PgTransaction,
  TIMEOUTS,
  TransactionTimeoutError,
  type TransactionClient,
} from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import {
  PostgresPool,
  type PgClient,
  type PgPool,
} from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');
const subject = '00000000-0000-0000-0000-000000000201';
let source: PostgresPool;

// prettier-ignore
describe('PgTransaction', () => {
  beforeAll(() => {
    source = new PostgresPool(PostgresConfig.fromUrl(url, { DATABASE_POOL_MAX: '2' }));
  });
  afterAll(() => source.end());
  it('rejects invalid input before acquisition', async () => {
    let acquired = false; const transaction = new PgTransaction({ connect: async () => { acquired = true; throw Error(); }, end: async () => undefined });
    await expect(transaction.run('invalid', async () => undefined)).rejects.toThrow('subject must be a valid UUID.'); expect(acquired).toBe(false);
  });
  it('keeps the shared callback timeout at one second', () => {
    expect(TIMEOUTS.callbackTimeoutMs).toBe(1_000);
  });
  it('uses ordered local setup and rolls back all begun stages', async () => {
    const expected = ['BEGIN', 'SET LOCAL ROLE savia_application', "select set_config('app.subject_id', $1, true)", 'select set_config($1, $2::text, true)', 'select set_config($1, $2::text, true)', 'select set_config($1, $2::text, true)', 'select pg_advisory_xact_lock(hashtextextended($1, 0))'];
    const complete = fakePool(); await new PgTransaction(complete).run(subject, async () => undefined); expect(complete.calls).toEqual([...expected, 'COMMIT']); expect(complete.releases).toEqual([undefined]);
    for (const failure of [2, 3, 4, 5, 6, 7, 8]) { const fake = fakePool(failure); await expect(new PgTransaction(fake).run(subject, async () => { throw Error('callback'); })).rejects.toThrow(); expect(fake.calls.slice(0, failure - 1)).toEqual(expected.slice(0, failure - 1)); expect(fake.calls).toContain('ROLLBACK'); expect(fake.releases).toEqual([failure === 8 ? expect.any(Error) : undefined]); }
  });
  it('serializes canonical locks on separate clients and clears context', async () => {
    const tx = transaction(); let release!: () => void; let entered = false; const ready = Promise.withResolvers<void>();
    const first = tx.run(subject.toUpperCase(), async client => { await expect(client.query<{ role: string; value: string }>("select current_user as role, current_setting('app.subject_id', true) as value")).resolves.toMatchObject({ rows: [{ role: 'savia_application', value: subject }] }); ready.resolve(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready.promise; const second = tx.run(subject, async () => { entered = true; }); await wait(80); expect(entered).toBe(false); release(); await Promise.all([first, second]);
    const client = await source.connect(); await expect(client.query("select current_setting('app.subject_id', true) as value")).resolves.toMatchObject({ rows: [{ value: '' }] }); client.release(); await tx.close();
  });
  it('recovers bounded checkout without entering callback', async () => {
    const pool = new PostgresPool(PostgresConfig.fromEnvironment({ DATABASE_URL: url, DATABASE_POOL_MAX: '1', DATABASE_CHECKOUT_TIMEOUT_MS: '50' })); const tx = new PgTransaction(pool, { checkoutTimeoutMs: 50 }); const holder = await pool.connect(); let entered = false;
    await expect(tx.run(subject, async () => { entered = true; })).rejects.toMatchObject({ name: 'TransactionAcquisitionTimeoutError', connectionTimeoutMillis: 50, cause: expect.any(Error) }); expect(entered).toBe(false); holder.release(); await expect(tx.run(subject, async client => client.query('select 1 as ready'))).resolves.toMatchObject({ rows: [{ ready: 1 }] }); await tx.close();
  });
  it('bounds callback, lock, statement, idle configuration, and late queries', async () => {
    const tx = transaction({ callbackTimeoutMs: 30, lockTimeoutMs: 30, statementTimeoutMs: 30, idleTransactionTimeoutMs: 1_000 }); let late!: TransactionClient;
    await expect(tx.run(subject, async client => { late = client; return new Promise<never>(() => undefined); })).rejects.toBeInstanceOf(TransactionTimeoutError); await expect(late.query('select 1')).rejects.toBeInstanceOf(TransactionTimeoutError); await expect(tx.run(subject, async client => client.query('select pg_sleep(0.1)'))).rejects.toBeInstanceOf(TransactionTimeoutError);
    const holder = await source.connect(); await holder.query('BEGIN'); await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [subject]); await expect(tx.run(subject, async () => undefined)).rejects.toBeInstanceOf(TransactionTimeoutError); await holder.query('ROLLBACK'); holder.release(); await tx.close();
  });
  it('cancels an in-flight callback query at its remaining deadline', async () => {
    const pool = new Pool({ connectionString: url, max: 1 }); const tx = new PgTransaction({ connect: async () => pool.connect(), end: async () => pool.end() }, { callbackTimeoutMs: 30, statementTimeoutMs: 1_000 }); const started = performance.now();
    await expect(tx.run(subject, async client => { await client.query('create temporary table callback_deadline_probe (value integer)'); await client.query('insert into callback_deadline_probe values (1)'); return client.query('select pg_sleep(0.5)'); })).rejects.toBeInstanceOf(TransactionTimeoutError); expect(performance.now() - started).toBeLessThan(250);
    const probe = await pool.connect(); await expect(probe.query("select to_regclass('pg_temp.callback_deadline_probe') as table_name, current_setting('app.subject_id', true) as subject_id")).resolves.toMatchObject({ rows: [{ table_name: null, subject_id: '' }] }); probe.release(); await tx.close();
  });
  it('replaces physical clients after uncertain commit and errors on rollback failure', async () => {
    const faulty = new FaultPool(transactionPool()); const tx = new PgTransaction(faulty); await expect(tx.run(subject, async () => undefined)).rejects.toBeInstanceOf(CommitOutcomeUnknownError); await tx.run(subject, async () => undefined); expect(faulty.rolledBack).toBe(true); expect(faulty.releasedWithError).toBe(true); expect(faulty.pids[0]).not.toBe(faulty.pids[1]); await tx.close();
    const failed = fakePool('ROLLBACK'); await expect(new PgTransaction(failed).run(subject, async () => { throw Error(); })).rejects.toThrow(); expect(failed.releases).toEqual([expect.any(Error)]);
  });
  // Reviewer drafts (verify mwtpt0ri).
  it('retains separate PostgreSQL statement and lock timeouts when opted in', async () => {
    const tx = transaction({ statementTimeoutMs: 700, lockTimeoutMs: 125 });
    const hold = { holdUntilCallbackSettles: true } as const;
    const sqlTimeout = {
      name: 'TransactionTimeoutError',
      message: 'PostgreSQL transaction timed out.',
    };

    await expect(
      tx.runAsQueueConsumer(
        (client) => client.query('select pg_sleep(5)'),
        hold,
      ),
    ).rejects.toMatchObject({ ...sqlTimeout, cause: { code: '57014' } });

    const holder = await source.connect();
    const lock = 'select pg_advisory_xact_lock(1356412354162::bigint)';
    try {
      await holder.query('BEGIN');
      await holder.query(lock);
      await expect(
        tx.runAsQueueConsumer((client) => client.query(lock), hold),
      ).rejects.toMatchObject({ ...sqlTimeout, cause: { code: '55P03' } });
    } finally {
      try {
        await holder.query('ROLLBACK');
      } finally {
        holder.release();
      }
    }
  });

  it('keeps the default, numeric, and object queue-consumer deadlines', async () => {
    const tx = transaction({
      callbackTimeoutMs: 500,
      idleTransactionTimeoutMs: 3_000,
    });
    const cases = [
      [undefined, 'TransactionTimeoutError', 'Transaction callback deadline elapsed.'],
      [500, 'DeliveryDeadlineExceededError', 'Delivery deadline exceeded.'],
      [{ timeoutMs: 500 }, 'DeliveryDeadlineExceededError', 'Delivery deadline exceeded.'],
    ] as const;

    for (const [options, name, message] of cases) {
      let entered = false;
      const gate = Promise.withResolvers<void>();
      try {
        await expect(
          tx.runAsQueueConsumer(() => {
            entered = true;
            return gate.promise;
          }, options),
        ).rejects.toMatchObject({ name, message });
        expect(entered).toBe(true);
      } finally {
        gate.resolve();
      }
    }
  });

  it('discards and logs a server-terminated checkout without exposing the backend error', async () => {
    const pool = new PostgresPool(PostgresConfig.fromUrl(url, { DATABASE_POOL_MAX: '1' }));
    const tx = new PgTransaction(pool, { callbackTimeoutMs: 500, idleTransactionTimeoutMs: 3_000 });
    const gate = Promise.withResolvers<void>();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pidSql = 'select pg_backend_pid() as pid';
    let terminatedPid: number | undefined;
    try {
      // Arm the server timeout before BEGIN, not after PostgreSQL has started
      // the transaction's timer. The backend must win the deadline race.
      const checkout = await pool.connect();
      try {
        await checkout.query("SET transaction_timeout = '150ms'");
      } finally {
        checkout.release();
      }
      await expect(tx.runAsQueueConsumer(async (client) => {
        terminatedPid = (await client.query<{ pid: number }>(pidSql)).rows[0]?.pid;
        await gate.promise;
      })).rejects.toMatchObject({
        name: 'TransactionTimeoutError',
        message: 'Transaction callback deadline elapsed.',
      });
      expect(terminatedPid).toEqual(expect.any(Number));
      expect(warn.mock.calls).toEqual([['PostgreSQL checked-out connection failed; discarded.']]);

      const readPid = async () => (await tx.runAsQueueConsumer((client) =>
        client.query<{ pid: number }>(pidSql),
      )).rows[0]?.pid;
      const replacement = await readPid();
      expect(replacement).toEqual(expect.any(Number));
      expect(replacement).not.toBe(terminatedPid);
      expect(await readPid()).toBe(replacement);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      warn.mockRestore();
      await tx.close();
    }
  });

  it('takes no advisory lock during runRead and sets session context', async () => {
    const tx = transaction(); const probe = "select count(*)::int as count from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()";
    await tx.run(subject, async client => { await expect(client.query<{ count: number }>(probe)).resolves.toMatchObject({ rows: [{ count: 1 }] }); });
    await tx.runRead(subject, async client => {
      await expect(client.query<{ role: string; value: string }>("select current_user as role, current_setting('app.subject_id', true) as value")).resolves.toMatchObject({ rows: [{ role: 'savia_application', value: subject }] });
      await expect(client.query<{ count: number }>(probe)).resolves.toMatchObject({ rows: [{ count: 0 }] });
    });
    const client = await source.connect(); await expect(client.query("select current_setting('app.subject_id', true) as value")).resolves.toMatchObject({ rows: [{ value: '' }] }); client.release(); await tx.close();
  });
  it('bounds a hung read callback and its late queries', async () => {
    const tx = transaction({ callbackTimeoutMs: 30, statementTimeoutMs: 30 }); let late!: TransactionClient;
    await expect(tx.runRead(subject, async client => { late = client; return new Promise<never>(() => undefined); })).rejects.toBeInstanceOf(TransactionTimeoutError); await expect(late.query('select 1')).rejects.toBeInstanceOf(TransactionTimeoutError);
    await expect(tx.runRead(subject, async client => client.query('select pg_sleep(0.1)'))).rejects.toBeInstanceOf(TransactionTimeoutError); await tx.close();
  });
  it('rejects writes inside read-only transaction', async () => {
    const tx = transaction();
    await tx.runRead(subject, async client => {
      await expect(client.query('create temporary table read_only_probe (value integer)')).rejects.toMatchObject({ code: '25006' });
    });
    await tx.close();
  });
});

// prettier-ignore
function transaction(options = {}): PgTransaction { return new PgTransaction(transactionPool(), options); }
// prettier-ignore
function transactionPool(): PgPool { return { connect: async () => source.connect(), end: async () => undefined }; }
// prettier-ignore
function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
// prettier-ignore
function fakePool(failure?: number | 'ROLLBACK') { const calls: string[] = []; const releases: (Error | undefined)[] = []; let count = 0; const client: PgClient = { query: async text => { calls.push(text); count++; if (failure === text || failure === count) throw Error('injected'); return { rows: [], command: '', rowCount: 0, oid: 0, fields: [] }; }, release: error => { releases.push(error); } }; return { calls, releases, connect: async () => client, end: async () => undefined } satisfies PgPool & { calls: string[]; releases: (Error | undefined)[] }; }
// prettier-ignore
class FaultPool implements PgPool { public rolledBack = false; public releasedWithError = false; public readonly pids: number[] = []; private failed = false; public constructor(private readonly pool: PgPool) {} public async connect(): Promise<PgClient> { const client = await this.pool.connect(); this.pids.push((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0); return { query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => { if (text === 'ROLLBACK') this.rolledBack = true; const result = await client.query<Row>(text, values); if (text === 'COMMIT' && !this.failed) { this.failed = true; throw Error('acknowledgement lost'); } return result; }, release: error => { this.releasedWithError ||= error !== undefined; client.release(error); } }; } public end(): Promise<void> { return this.pool.end(); } }
