import { Injectable } from '@nestjs/common';
import type {
  JobQueue,
  QueueMessage,
  QueueMessageEnvelope,
} from './job-queue.port.js';
import { PgTransaction } from './pg-transaction.js';

interface ClaimedJobRow extends Record<string, unknown> {
  readonly msg_id: string | number;
  readonly read_ct: number;
  readonly enqueued_at: string | Date;
  readonly vt: string | Date;
  readonly message: QueueMessageEnvelope;
}

@Injectable()
export class PgmqJobQueueAdapter implements JobQueue {
  public constructor(private readonly transaction: PgTransaction) {}

  public async claim(
    vtSeconds: number,
    limit: number,
    timeoutMs?: number,
  ): Promise<readonly QueueMessage[]> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const result = await client.query<ClaimedJobRow>(
        `select msg_id, read_ct, enqueued_at, vt, message
           from public.claim_jobs($1::integer, $2::integer)`,
        [vtSeconds, limit],
      );
      return result.rows.map((row) => ({
        msgId: row.msg_id,
        readCt: Number(row.read_ct),
        enqueuedAt:
          row.enqueued_at instanceof Date
            ? row.enqueued_at.toISOString()
            : String(row.enqueued_at),
        vt: row.vt instanceof Date ? row.vt.toISOString() : String(row.vt),
        message: row.message,
      }));
    }, timeoutMs);
  }

  public async ack(
    msgId: number | string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const result = await client.query<{ ack_job: boolean }>(
        `select public.ack_job($1::bigint) as ack_job`,
        [msgId],
      );
      return result.rows[0]?.ack_job ?? false;
    }, timeoutMs);
  }

  public async archive(
    msgId: number | string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const result = await client.query<{ archive_job: boolean }>(
        `select public.archive_job($1::bigint) as archive_job`,
        [msgId],
      );
      return result.rows[0]?.archive_job ?? false;
    }, timeoutMs);
  }

  public async defer(
    msgId: number | string,
    delaySeconds: number,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const result = await client.query(
        `select * from public.defer_job($1::bigint, $2::integer)`,
        [msgId, delaySeconds],
      );
      return (result.rowCount ?? 0) > 0;
    }, timeoutMs);
  }

  public async failOrphanedJob(
    jobId: string,
    actorId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.transaction.runAsQueueConsumer(async (client) => {
      const result = await client.query<{ fail_orphaned_job: boolean }>(
        `select public.fail_orphaned_job($1::uuid, $2::uuid) as fail_orphaned_job`,
        [jobId, actorId],
      );
      return result.rows[0]?.fail_orphaned_job ?? false;
    }, timeoutMs);
  }
}
