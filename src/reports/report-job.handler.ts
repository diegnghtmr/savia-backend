import { Inject, Injectable } from '@nestjs/common';
import { DeliveryDeadlineExceededError } from '../platform/delivery-deadline.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import type {
  JobExecutionContext,
  JobHandler,
} from '../platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { PROBLEM_TYPES } from '../platform/problem-details.js';
import type { ReportGrid } from './report-engine.js';
import { computePreparedReportGrid } from './report-computation.js';
import {
  parseReportJobPayload,
  type ReportJobPayload,
} from './report-job-payload.js';
import { PostgresReportAdapter } from './postgres-report.adapter.js';
import { serializeReport } from './report-serializers.js';
import { ReportBudgetMissingError } from './report.port.js';

const REPORT_WRITE_ROLES = {
  OWNER: 'owner',
  ADMINISTRATOR: 'administrator',
  EDITOR: 'editor',
} as const;

type ReportWriteRole =
  (typeof REPORT_WRITE_ROLES)[keyof typeof REPORT_WRITE_ROLES];

const WRITE_ROLE_VALUES: readonly string[] = Object.values(REPORT_WRITE_ROLES);

export class ReportWriteForbiddenError extends Error {
  public readonly isDomainError = true;
  public readonly type = PROBLEM_TYPES.FORBIDDEN;
  public readonly title = 'Forbidden';
  public readonly status = 403;
  public readonly code = 'forbidden';

  public constructor() {
    super('Workspace access forbidden');
    this.name = 'ReportWriteForbiddenError';
  }
}

function isWriteRole(role: string | undefined): role is ReportWriteRole {
  return WRITE_ROLE_VALUES.includes(role ?? '');
}

export interface ReportJobComputed {
  readonly downloadUrl: string;
  readonly expiresAt: Date;
  readonly completedAt: Date;
}

@Injectable()
export class ReportJobHandler
  implements JobHandler<ReportJobPayload, ReportGrid, ReportJobComputed>
{
  public readonly jobType = JOB_WRITER_TYPES.REPORT_RUN;

  public constructor(
    private readonly store: PostgresReportAdapter,
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public parsePayload(
    raw: unknown,
    execution?: Pick<JobExecutionContext<unknown>, 'workspaceId'>,
  ): ReportJobPayload {
    return parseReportJobPayload(raw, execution?.workspaceId);
  }

  public async compute(
    context: JobExecutionContext<ReportJobPayload>,
    client: TransactionClient,
  ): Promise<ReportGrid> {
    const payload = context.payload;
    const rows = await this.store.readReportSourceRows(
      client,
      context.workspaceId,
      payload.periodStart,
      payload.periodTo,
      new Date(payload.asOf),
      payload.shapeTypeFilter ?? undefined,
      payload.callerType ?? undefined,
    );
    const budget = await this.store.readBudgetedMinorByBucket(
      client,
      context.workspaceId,
      payload.periodStart,
      payload.periodTo,
      payload.dimensions,
    );
    if (payload.preset === 'budget' && budget.size === 0) {
      throw new ReportBudgetMissingError();
    }
    return computePreparedReportGrid({
      rows,
      dimensions: payload.dimensions,
      measures: payload.measures,
      baseCurrency: payload.baseCurrency,
      budgetedMinorByBucket: budget,
      preset: payload.preset,
    });
  }

  public async materialize(
    context: JobExecutionContext<ReportJobPayload>,
    computed: ReportGrid,
    timeoutMs: number,
  ): Promise<ReportJobComputed> {
    return this.runBounded(timeoutMs, async () => {
      const artifact = await serializeReport(context.payload.format, computed);
      await this.storage.upload(
        context.payload.objectKey,
        artifact.content,
        artifact.contentType,
      );
      const completedAt = this.clock();
      const signature = await this.storage.sign(
        context.payload.objectKey,
        new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      );
      return {
        downloadUrl: signature.url,
        expiresAt: signature.expiresAt,
        completedAt,
      };
    });
  }

  private async runBounded<T>(
    timeoutMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new DeliveryDeadlineExceededError(
                'Report artifact I/O exceeded the delivery work cap.',
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async persist(
    context: JobExecutionContext<ReportJobPayload>,
    computed: ReportJobComputed,
    client: TransactionClient,
  ): Promise<string> {
    const role = await this.store.readActiveRole(client, context.workspaceId);
    if (!isWriteRole(role)) {
      throw new ReportWriteForbiddenError();
    }
    await this.store.beginProcessingReportRun(
      client,
      context.workspaceId,
      context.payload.reportRunId,
      context.jobId,
    );
    await this.store.completeProcessingReportRun(
      client,
      context.workspaceId,
      context.payload.reportRunId,
      context.jobId,
      {
        downloadUrl: computed.downloadUrl,
        expiresAt: computed.expiresAt,
        completedAt: computed.completedAt,
      },
    );
    return context.payload.reportRunId;
  }
}
