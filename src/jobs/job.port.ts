import type { TransactionClient } from '../platform/pg-transaction.js';

export const JOBS_PORT = Symbol('JobsPort');

export const JOB_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'dead_letter',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = ['import_commit', 'import_rollback'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface Job {
  readonly id: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly progressPercent: number | null;
  readonly resultResourceId: string | null;
  readonly error: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export const JOB_READ_OUTCOMES = {
  FOUND: 'found',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
} as const;

export type JobReadOutcomeKind =
  (typeof JOB_READ_OUTCOMES)[keyof typeof JOB_READ_OUTCOMES];

export interface JobReadFound {
  readonly kind: typeof JOB_READ_OUTCOMES.FOUND;
  readonly job: Job;
}

export interface JobReadNotFound {
  readonly kind: typeof JOB_READ_OUTCOMES.NOT_FOUND;
}

export interface JobReadForbidden {
  readonly kind: typeof JOB_READ_OUTCOMES.FORBIDDEN;
}

export type JobReadOutcome = JobReadFound | JobReadNotFound | JobReadForbidden;

export interface JobStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  findJobById(
    client: TransactionClient,
    workspaceId: string,
    jobId: string,
  ): Promise<Job | undefined>;
}

export interface JobsPort {
  getJob(
    subject: string,
    workspaceId: string,
    jobId: string,
  ): Promise<JobReadOutcome>;
}
