export const JOB_QUEUE = Symbol('JobQueue');

export interface QueueMessageEnvelope {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly actor_id?: string;
}

export interface QueueMessage<T = QueueMessageEnvelope> {
  readonly msgId: number | string;
  readonly readCt: number;
  readonly enqueuedAt: string;
  readonly vt: string;
  readonly message: T;
}

export interface JobQueue {
  claim(
    vtSeconds: number,
    limit: number,
    timeoutMs?: number,
  ): Promise<readonly QueueMessage[]>;
  ack(msgId: number | string, timeoutMs?: number): Promise<boolean>;
  archive(msgId: number | string, timeoutMs?: number): Promise<boolean>;
  defer(
    msgId: number | string,
    delaySeconds: number,
    timeoutMs?: number,
  ): Promise<boolean>;
  failOrphanedJob(
    jobId: string,
    actorId: string,
    timeoutMs?: number,
  ): Promise<boolean>;
}
