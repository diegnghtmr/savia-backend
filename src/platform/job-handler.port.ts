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

export const JOB_OCR_BUDGETS = {
  RECEIPT_OCR: 'receipt_ocr',
} as const;

export type JobOcrBudget =
  (typeof JOB_OCR_BUDGETS)[keyof typeof JOB_OCR_BUDGETS];

export interface OcrJobHandler<P = unknown, C = unknown, R = C>
  extends BaseJobHandler<P, C, R> {
  readonly ocrBudget: JobOcrBudget;
  readonly renderBudget?: never;
  readonly render?: never;
  download(
    context: JobExecutionContext<P>,
    computed: C,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Buffer>;
  ocr(
    context: JobExecutionContext<P>,
    downloaded: Buffer,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<R>;
}

export interface RenderingJobHandler<P = unknown, C = unknown, R = C>
  extends BaseJobHandler<P, C, R> {
  readonly renderBudget: JobRenderBudget;
  readonly ocrBudget?: never;
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
  readonly ocrBudget?: never;
}

export type JobHandler<P = unknown, C = unknown, R = C> =
  | RenderingJobHandler<P, C, R>
  | NonRenderingJobHandler<P, C, R>
  | OcrJobHandler<P, C, R>;
