import type { TransactionClient } from './pg-transaction.js';

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

export interface JobExecutionContext<P> {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly attemptCount: number;
  readonly payload: P;
}

export interface JobHandler<P = unknown, R = unknown> {
  readonly jobType: string;
  parsePayload(raw: unknown): P;
  compute(
    context: JobExecutionContext<P>,
    client: TransactionClient,
  ): Promise<R>;
  persist(
    context: JobExecutionContext<P>,
    computed: R,
    client: TransactionClient,
  ): Promise<string | null | void>;
  onFailure?(
    context: JobExecutionContext<P>,
    error: unknown,
    client?: TransactionClient,
    timeoutMs?: number,
  ): Promise<void>;
}
