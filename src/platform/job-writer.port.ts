import type { TransactionClient } from './pg-transaction.js';

export const JOB_WRITER = Symbol('JobWriter');

export const JOB_WRITER_TYPES = {
  IMPORT_COMMIT: 'import_commit',
  IMPORT_ROLLBACK: 'import_rollback',
  BALANCE_FORECAST: 'balance_forecast',
  REPORT_RUN: 'report_run',
  EXPORT_JOB: 'export_job',
} as const;

export type JobWriterType =
  (typeof JOB_WRITER_TYPES)[keyof typeof JOB_WRITER_TYPES];

export interface TerminalJob {
  readonly id: string;
  readonly type: string;
  readonly status: 'completed' | 'failed';
  readonly progressPercent: number | null;
  readonly resultResourceId: string | null;
  readonly error: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface JobWriter {
  createTerminalJob(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    type: JobWriterType,
    status: 'completed' | 'failed',
    resultResourceId: string | null,
    error: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;

  createQueuedJob(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    type: JobWriterType,
    payload?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;

  transitionToProcessing(
    client: TransactionClient,
    workspaceId: string,
    jobId: string,
    attemptCount?: number,
  ): Promise<Record<string, unknown>>;
}
