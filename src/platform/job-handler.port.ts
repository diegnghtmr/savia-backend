import type { TransactionClient } from './pg-transaction.js';

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

export interface JobExecutionContext<P> {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly attemptCount: number;
  readonly payload: P;
}

export const JOB_RENDER_BUDGETS = {
  PDF_RENDER: 'pdf_render',
  EXPORT_SERIALIZE: 'export_serialize',
} as const;

export type JobRenderBudget =
  (typeof JOB_RENDER_BUDGETS)[keyof typeof JOB_RENDER_BUDGETS];

export interface BaseJobHandler<P = unknown, C = unknown, R = C> {
  readonly jobType: string;
  parsePayload(
    raw: unknown,
    execution?: Pick<JobExecutionContext<unknown>, 'workspaceId'>,
  ): P;
  compute(
    context: JobExecutionContext<P>,
    client: TransactionClient,
  ): Promise<C>;
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

export interface RenderingJobHandler<P = unknown, C = unknown, R = C>
  extends BaseJobHandler<P, C, R> {
  readonly renderBudget: JobRenderBudget;
  render(
    context: JobExecutionContext<P>,
    computed: C,
    timeoutMs: number,
  ): Promise<unknown>;
}

export interface NonRenderingJobHandler<P = unknown, C = unknown, R = C>
  extends BaseJobHandler<P, C, R> {
  readonly renderBudget?: never;
  readonly render?: never;
}

export type JobHandler<P = unknown, C = unknown, R = C> =
  | RenderingJobHandler<P, C, R>
  | NonRenderingJobHandler<P, C, R>;
