import { Logger, type OnApplicationShutdown } from '@nestjs/common';

import type { PgClient, PgPool } from './postgres-pool.js';
import { UUID_PATTERN } from './uuid.js';
export const TIMEOUTS = {
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
export class ActorVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ActorVerificationError';
  }
}
export interface WorkerWriteContext {
  readonly workspaceId: string;
  readonly jobId: string;
}
export interface PgTransactionOptions {
  readonly workerMode?: boolean;
  readonly poolCloseGraceMs?: number;
}
const UUID = UUID_PATTERN;
// prettier-ignore
export class PgTransaction implements OnApplicationShutdown {
  // Timeouts may arrive as a thunk for the same reason the pool configuration
  // does: their value comes from that configuration, which must not be resolved
  // while the module graph is being built. See PostgresPool.
  private resolvedTimeouts: Required<TransactionTimeoutOptions> | undefined;
  private readonly logger = new Logger(PgTransaction.name);
  public constructor(
    private readonly pool: PgPool,
    private readonly timeoutOptions: TransactionTimeoutOptions | (() => TransactionTimeoutOptions) = {},
    private readonly options: PgTransactionOptions = {},
  ) {}
  private get timeouts(): Required<TransactionTimeoutOptions> { return (this.resolvedTimeouts ??= { ...TIMEOUTS, ...(typeof this.timeoutOptions === 'function' ? this.timeoutOptions() : this.timeoutOptions) }); }
  public async run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
    context?: WorkerWriteContext,
  ): Promise<T> {
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
      if (context) {
        const checkRes = await client.query<{
          workspace_id: string;
          created_by: string;
          role: string | null;
        }>(
          `select j.workspace_id::text as workspace_id,
                  j.created_by::text as created_by,
                  public.workspace_actor_active_role(j.workspace_id) as role
             from public.jobs j
            where j.id = $1::uuid`,
          [context.jobId],
        );
        const row = checkRes.rows[0];
        if (
          !row ||
          row.workspace_id !== context.workspaceId ||
          row.created_by !== subject.toLowerCase() ||
          !['owner', 'administrator', 'editor'].includes(row.role ?? '')
        ) {
          throw new ActorVerificationError(
            `Actor ${subject} lacks valid write permissions for job ${context.jobId} in workspace ${context.workspaceId}.`,
          );
        }
      }
      const callbackDeadline = monotonicDeadline(this.timeouts.callbackTimeoutMs);
      let active = true;
      const transactionClient: TransactionClient = { query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const remaining = remainingMilliseconds(callbackDeadline);
        if (!active || remaining < 1) throw deadlineError();
        if (!text.trim().toUpperCase().startsWith('ROLLBACK TO')) {
          await client.query('select set_config($1, $2::text, true)', ['statement_timeout', `${Math.min(this.timeouts.statementTimeoutMs, remaining)}ms`]);
        }
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

  public async runAnonymous<T>(callback: (client: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET LOCAL ROLE savia_application');
      await this.configureTimeouts(client);
      const result = await callback({
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => client.query<Row>(text, values),
      });
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      const rollbackError = began ? await client.query('ROLLBACK').catch(asError) : asError(error);
      client.release(rollbackError instanceof Error ? rollbackError : undefined);
      throw databaseTimeout(error);
    }
  }

  public async runAsQueueConsumer<T>(callback: (client: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET LOCAL ROLE savia_worker');
      await this.configureTimeouts(client);
      const callbackDeadline = monotonicDeadline(this.timeouts.callbackTimeoutMs);
      let active = true;
      const transactionClient: TransactionClient = {
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          const remaining = remainingMilliseconds(callbackDeadline);
          if (!active || remaining < 1) throw deadlineError();
          if (!text.trim().toUpperCase().startsWith('ROLLBACK TO')) {
            await client.query('select set_config($1, $2::text, true)', [
              'statement_timeout',
              `${Math.min(this.timeouts.statementTimeoutMs, remaining)}ms`,
            ]);
          }
          if (!active || remainingMilliseconds(callbackDeadline) < 1) throw deadlineError();
          return client.query<Row>(text, values);
        },
      };
      const result = await deadline(
        callback(transactionClient),
        remainingMilliseconds(callbackDeadline),
        () => (active = false),
      ).finally(() => (active = false));
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

  public async runRead<T>(subject: string, callback: (client: TransactionClient) => Promise<T>): Promise<T> {
    if (!UUID.test(subject)) throw new Error('subject must be a valid UUID.');
    const client = await this.acquire();
    let began = false;
    try {
      if (this.options.workerMode) {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      } else {
        await client.query('BEGIN READ ONLY');
      }
      began = true;
      await client.query('SET LOCAL ROLE savia_application');
      await client.query("select set_config('app.subject_id', $1, true)", [subject.toLowerCase()]);
      await this.configureTimeouts(client);
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
      await client.query('ROLLBACK');
      client.release();
      return result;
    } catch (error) {
      const rollbackError = began ? await client.query('ROLLBACK').catch(asError) : asError(error);
      client.release(rollbackError instanceof Error ? rollbackError : undefined);
      throw databaseTimeout(error);
    }
  }

  public close(): Promise<void> { return this.pool.end(); }
  public async onApplicationShutdown(): Promise<void> {
    if (!this.options.workerMode) {
      await this.close();
      return;
    }
    const graceMs = this.options.poolCloseGraceMs ?? 5_000;
    const closePromise = this.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      closePromise.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (timedOut) {
      void closePromise.catch(() => undefined);
      this.logger.warn(
        `PostgreSQL pool did not close within ${graceMs}ms; continuing shutdown.`,
      );
    }
  }
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
