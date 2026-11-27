import {
  JOB_WRITER_TYPES,
  type JobWriter,
} from '../platform/job-writer.port.js';
import type { PgTransaction } from '../platform/pg-transaction.js';
import type { PostgresOccurrenceAdapter } from './postgres-occurrence.adapter.js';

export class RecurringJobSweep {
  public constructor(
    private readonly transaction: Pick<
      PgTransaction,
      'run' | 'runAsQueueConsumer'
    >,
    private readonly store: Pick<
      PostgresOccurrenceAdapter,
      'findDue' | 'hasJob' | 'lockDue'
    >,
    private readonly jobs: Pick<JobWriter, 'createQueuedJob'>,
    private readonly timeoutMs: number,
  ) {}

  public async sweep(cutoff = new Date()): Promise<number> {
    const asOf = cutoff.toISOString();
    const end = performance.now() + this.timeoutMs;
    const due = await this.transaction.runAsQueueConsumer(
      (client) => this.store.findDue(client, asOf),
      this.timeoutMs,
    );
    let count = 0;
    for (const candidate of due) {
      const timeLeft = Math.floor(end - performance.now());
      if (timeLeft <= 0) break;
      const published = await this.transaction.run(
        candidate.subject,
        async (client) => {
          if (
            !(await this.store.lockDue(client, candidate)) ||
            (await this.store.hasJob(client, candidate))
          )
            return false;
          const { workspaceId, subject, ruleId, scheduledAt, scheduleVersion } =
            candidate;
          await this.jobs.createQueuedJob(
            client,
            workspaceId,
            subject,
            JOB_WRITER_TYPES.RECURRING_MATERIALIZATION,
            {
              ruleId,
              scheduledAt,
              asOf,
              ...(scheduleVersion !== undefined && { scheduleVersion }),
            },
          );
          return true;
        },
        undefined,
        undefined,
        timeLeft,
      );
      if (published) count++;
    }
    return count;
  }
}
