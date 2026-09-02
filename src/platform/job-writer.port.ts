import type { TransactionClient } from './pg-transaction.js';
export const JOB_WRITER = Symbol('JobWriter');
export type JobWriterType = 'import_commit' | 'import_rollback';
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
}
