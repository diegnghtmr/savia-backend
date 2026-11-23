import {
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ArtifactStorageClientError,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { PgTransaction } from '../platform/pg-transaction.js';

export const BACKUP_RETENTION_BATCH_SIZE = 50;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const STORAGE_BUDGET_MS = 10_000;
const TRANSACTION_BUDGET_MS = 12_000;
const SHUTDOWN_WAIT_MS = 1_000;
const PREFIX = 'backups/';
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const BACKUP_PATH = new RegExp(
  `^${PREFIX}(${UUID})/(${UUID})/(${UUID})\\.zip$`,
);

type List = NonNullable<ArtifactStorage['list']>;

export class BackupRetentionTask
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(BackupRetentionTask.name);
  private readonly shutdown = new AbortController();
  private readonly intervalMs: number;
  private readonly safetyWindowMs: number;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private after?: string;

  public constructor(
    private readonly tx: PgTransaction,
    private readonly storage: ArtifactStorage,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.intervalMs =
      1_000 *
      seconds(
        environment,
        'SAVIA_BACKUP_RETENTION_INTERVAL_SECONDS',
        HOUR_SECONDS,
        1,
        DAY_SECONDS,
      );
    // One hour is also the maximum validated worker delivery lease.
    this.safetyWindowMs =
      1_000 *
      seconds(
        environment,
        'SAVIA_BACKUP_RETENTION_SAFETY_WINDOW_SECONDS',
        DAY_SECONDS,
        HOUR_SECONDS,
        365 * DAY_SECONDS,
      );
  }

  public onApplicationBootstrap(): void {
    if (this.storage.list && !this.timer && !this.shutdown.signal.aborted) {
      this.schedule();
    }
  }

  public async beforeApplicationShutdown(): Promise<void> {
    clearTimeout(this.timer);
    this.shutdown.abort();
    if (!this.pending) return;
    const wait = new AbortController();
    try {
      await Promise.race([
        this.pending,
        delay(SHUTDOWN_WAIT_MS, undefined, { signal: wait.signal }),
      ]);
    } finally {
      wait.abort();
    }
  }

  public runOnce(): Promise<void> {
    const list = this.storage.list;
    if (!list || this.shutdown.signal.aborted) return Promise.resolve();
    return (this.pending ??= this.sweep(list.bind(this.storage))
      .catch(() => {
        if (!this.shutdown.signal.aborted) {
          this.logger.warn('Workspace backup retention sweep failed.');
        }
      })
      .finally(() => {
        this.pending = undefined;
      }));
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.runOnce().then(() => {
        if (!this.shutdown.signal.aborted) this.schedule();
      });
    }, this.intervalMs).unref();
  }

  private async sweep(list: List): Promise<void> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(STORAGE_BUDGET_MS),
    ]);
    const before = new Date(Date.now() - this.safetyWindowMs);
    this.after = await this.tx.runAsQueueConsumer(async (client) => {
      signal.throwIfAborted();
      // Released automatically by commit, rollback, or connection loss. Separate
      // from the worker's actor locks (which use the single-bigint key space).
      const { rows: lock } = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_xact_lock(1935767145, 1) as acquired',
      );
      if (!lock[0]?.acquired) return this.after;

      const objects = await abortable(signal, () =>
        list(PREFIX, {
          after: this.after,
          before,
          limit: BACKUP_RETENTION_BATCH_SIZE,
          signal,
        }),
      );
      const page = objects.slice(0, BACKUP_RETENTION_BATCH_SIZE);
      for (const { path, createdAt } of page) {
        const match = BACKUP_PATH.exec(path);
        if (!match || !(createdAt.getTime() < before.getTime())) continue;
        signal.throwIfAborted();
        const [, workspaceId, backupId, attemptId] = match;
        // Fresh read after listing, before each DELETE. A nonterminal job is
        // never eligible; a terminal job cannot be restarted by the runner.
        const { rows } = await client.query<{ allowed: boolean }>(
          'select public.can_remove_workspace_backup_object($1, $2, $3) as allowed',
          [workspaceId, backupId, attemptId],
        );
        if (!rows[0]?.allowed) continue;
        try {
          await abortable(signal, () => this.storage.remove(path, signal));
        } catch (error) {
          signal.throwIfAborted();
          if (
            !(
              error instanceof ArtifactStorageClientError &&
              error.status === 404
            )
          ) {
            this.logger.warn(
              `Workspace backup retention removal failed for backup ${backupId}.`,
            );
          }
        }
      }
      return page.length < BACKUP_RETENTION_BATCH_SIZE
        ? undefined
        : page.at(-1)?.path;
    }, TRANSACTION_BUDGET_MS);
  }
}

function seconds(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = environment[key]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

async function abortable<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, work()]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
