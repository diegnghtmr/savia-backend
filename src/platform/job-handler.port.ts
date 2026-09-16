import type { TransactionClient } from './pg-transaction.js';

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

export interface JobExecutionContext<P> {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly attemptCount: number;
  readonly payload: P;
}

export interface JobHandler<P = unknown, C = unknown, R = C> {
  readonly jobType: string;
  parsePayload(
    raw: unknown,
    execution?: Pick<JobExecutionContext<unknown>, 'workspaceId'>,
  ): P;
  compute(
    context: JobExecutionContext<P>,
    client: TransactionClient,
  ): Promise<C>;
  render?(
    context: JobExecutionContext<P>,
    computed: C,
    timeoutMs: number,
  ): Promise<unknown>;
  store?(
    context: JobExecutionContext<P>,
    rendered: unknown,
    timeoutMs: number,
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
