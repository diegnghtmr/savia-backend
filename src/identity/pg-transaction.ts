import type { OnApplicationShutdown } from '@nestjs/common';

import type { PgClient, PgPool } from './postgres-pool.js';
const TIMEOUTS = {
  checkoutTimeoutMs: 1_000,
  lockTimeoutMs: 1_000,
  statementTimeoutMs: 1_000,
  idleTransactionTimeoutMs: 1_000,
  callbackTimeoutMs: 1_000,
} as const;
type TransactionTimeoutOptions = Partial<Record<keyof typeof TIMEOUTS, number>>;
export type TransactionClient = Pick<PgClient, 'query'>;
export class TransactionTimeoutError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransactionTimeoutError';
  }
}
export class TransactionAcquisitionTimeoutError extends TransactionTimeoutError {
  public constructor(
    public readonly connectionTimeoutMillis: number,
    cause: unknown,
  ) {
    super('PostgreSQL pool checkout timed out.', cause);
    this.name = 'TransactionAcquisitionTimeoutError';
  }
}
export class CommitOutcomeUnknownError extends Error {
  public constructor(cause: unknown) {
    super('PostgreSQL commit acknowledgement is uncertain.', { cause });
    this.name = 'CommitOutcomeUnknownError';
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// prettier-ignore
export class PgTransaction implements OnApplicationShutdown {
  // Timeouts may arrive as a thunk for the same reason the pool configuration
  // does: their value comes from that configuration, which must not be resolved
  // while the module graph is being built. See PostgresPool.
  private resolvedTimeouts: Required<TransactionTimeoutOptions> | undefined;
  public constructor(private readonly pool: PgPool, private readonly timeoutOptions: TransactionTimeoutOptions | (() => TransactionTimeoutOptions) = {}) {}
  private get timeouts(): Required<TransactionTimeoutOptions> { return (this.resolvedTimeouts ??= { ...TIMEOUTS, ...(typeof this.timeoutOptions === 'function' ? this.timeoutOptions() : this.timeoutOptions) }); }
  public async run<T>(subject: string, callback: (client: TransactionClient) => Promise<T>): Promise<T> {
    if (!UUID.test(subject)) throw new Error('subject must be a valid UUID.');
    const client = await this.acquire();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET LOCAL ROLE savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [subject.toLowerCase()]);
      await this.configureTimeouts(client);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [subject.toLowerCase()]);
      const callbackDeadline = monotonicDeadline(this.timeouts.callbackTimeoutMs);
      let active = true;
      const transactionClient: TransactionClient = { query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const remaining = remainingMilliseconds(callbackDeadline);
        if (!active || remaining < 1) throw deadlineError();
        await client.query('select set_config($1, $2::text, true)', ['statement_timeout', `${Math.min(this.timeouts.statementTimeoutMs, remaining)}ms`]);
        if (!active || remainingMilliseconds(callbackDeadline) < 1) throw deadlineError();
        return client.query<Row>(text, values);
      } };
      const result = await deadline(callback(transactionClient), remainingMilliseconds(callbackDeadline), () => (active = false)).finally(() => (active = false));
      try {
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release(asError(error));
        throw new CommitOutcomeUnknownError(error);
      }
      client.release();
      return result;
    } catch (error) {
      if (!(error instanceof CommitOutcomeUnknownError)) {
        const rollbackError = began ? await client.query('ROLLBACK').catch(asError) : asError(error);
        client.release(rollbackError instanceof Error ? rollbackError : undefined);
      }
      throw databaseTimeout(error);
    }
  }

  public close(): Promise<void> { return this.pool.end(); }
  public onApplicationShutdown(): Promise<void> { return this.close(); }
  private async acquire(): Promise<PgClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      if (isPoolTimeout(error)) {
        throw new TransactionAcquisitionTimeoutError(this.timeouts.checkoutTimeoutMs, error);
      }
      throw databaseTimeout(error);
    }
  }

  private async configureTimeouts(client: PgClient): Promise<void> {
    for (const [name, value] of [['lock_timeout', this.timeouts.lockTimeoutMs], ['statement_timeout', this.timeouts.statementTimeoutMs], ['idle_in_transaction_session_timeout', this.timeouts.idleTransactionTimeoutMs]] as const) {
      await client.query('select set_config($1, $2::text, true)', [name, `${value}ms`]);
    }
  }
}
function isPoolTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('timeout exceeded when trying to connect')
  );
}
function databaseTimeout(error: unknown): Error {
  if (error instanceof TransactionTimeoutError) return error;
  if (
    error instanceof Error &&
    'code' in error &&
    ['55P03', '57014', '25P03'].includes(String(error.code))
  ) {
    return new TransactionTimeoutError(
      'PostgreSQL transaction timed out.',
      error,
    );
  }
  return asError(error);
}
function deadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  expire: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expire();
      reject(deadlineError());
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(
    () => timer && clearTimeout(timer),
  );
}
function monotonicDeadline(timeoutMs: number): bigint {
  return process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
}
function remainingMilliseconds(deadline: bigint): number {
  return Math.floor(Number(deadline - process.hrtime.bigint()) / 1_000_000);
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('PostgreSQL client error.');
}

function deadlineError(): TransactionTimeoutError {
  return new TransactionTimeoutError('Transaction callback deadline elapsed.');
}
