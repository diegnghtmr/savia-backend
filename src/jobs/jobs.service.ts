import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  JOB_READ_OUTCOMES,
  type JobReadOutcome,
  type JobsPort,
  type JobStore,
} from './job.port.js';

export interface JobsTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class JobsService implements JobsPort {
  public constructor(
    private readonly transaction: JobsTransaction,
    private readonly store: JobStore,
  ) {}

  public async getJob(
    subject: string,
    workspaceId: string,
    jobId: string,
  ): Promise<JobReadOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      // 1. Role check: owner, administrator, editor, viewer
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor', 'viewer'].includes(role)
      ) {
        return { kind: JOB_READ_OUTCOMES.FORBIDDEN };
      }

      // 2. Find job scoped to workspace
      const job = await this.store.findJobById(client, workspaceId, jobId);
      if (!job) {
        return { kind: JOB_READ_OUTCOMES.NOT_FOUND };
      }

      return {
        kind: JOB_READ_OUTCOMES.FOUND,
        job,
      };
    });
  }
}
