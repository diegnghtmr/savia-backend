import { Inject, Injectable } from '@nestjs/common';
import { DeliveryDeadlineExceededError } from '../platform/delivery-deadline.js';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import {
  JOB_RENDER_BUDGETS,
  type JobExecutionContext,
  type RenderingJobHandler,
} from '../platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import {
  PDF_RENDERER,
  type PdfRenderer,
} from '../platform/pdf-renderer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { PROBLEM_TYPES } from '../platform/problem-details.js';
import type { ReportGrid } from './report-engine.js';
import { computePreparedReportGrid } from './report-computation.js';
import { renderReportHtml } from './report-html-template.js';
import {
  parseReportJobPayload,
  ReportJobPayloadError,
  type ReportJobPayload,
} from './report-job-payload.js';
import { PostgresReportAdapter } from './postgres-report.adapter.js';
import {
  serializeReport,
  type SerializedReport,
} from './report-serializers.js';
import {
  REPORT_PDF_ROW_CAP,
  REPORT_RUN_STATUS,
  ReportBudgetMissingError,
  ReportPdfRowCapExceededError,
} from './report.port.js';

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

function isSerializedReport(value: unknown): value is SerializedReport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SerializedReport>;
  return (
    Buffer.isBuffer(candidate.content) &&
    typeof candidate.contentType === 'string'
  );
}

export interface ReportJobComputed {
  readonly downloadUrl: string;
  readonly expiresAt: Date;
  readonly completedAt: Date;
}

@Injectable()
export class ReportJobHandler
  implements
    RenderingJobHandler<ReportJobPayload, ReportGrid, ReportJobComputed>
{
  public readonly jobType = JOB_WRITER_TYPES.REPORT_RUN;
  public readonly renderBudget = JOB_RENDER_BUDGETS.PDF_RENDER;
  private readonly clock: () => Date;

  public constructor(
    private readonly reports: PostgresReportAdapter,
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage,
    @Inject(PDF_RENDERER) private readonly pdfRenderer: PdfRenderer,
    clock: (() => Date) | undefined,
    public readonly renderSettleTimeoutMs: number,
  ) {
    this.clock = clock ?? (() => new Date());
  }

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
    const binding = await this.reports.readReportRunBinding(
      client,
      context.workspaceId,
      payload.reportRunId,
    );
    if (
      binding === undefined ||
      binding.jobId !== context.jobId ||
      (binding.status !== REPORT_RUN_STATUS.QUEUED &&
        binding.status !== REPORT_RUN_STATUS.PROCESSING)
    ) {
      throw new ReportJobPayloadError(
        'Report job payload reportRunId is not bound to this job.',
      );
    }
    const rows = await this.reports.readReportSourceRows(
      client,
      context.workspaceId,
      payload.periodStart,
      payload.periodTo,
      new Date(payload.asOf),
      payload.shapeTypeFilter ?? undefined,
      payload.callerType ?? undefined,
    );
    const budget = await this.reports.readBudgetedMinorByBucket(
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

  public async render(
    context: JobExecutionContext<ReportJobPayload>,
    computed: ReportGrid,
    timeoutMs: number,
  ): Promise<SerializedReport> {
    const { format } = context.payload;
    if (format === 'pdf') {
      if (computed.rows.length > REPORT_PDF_ROW_CAP) {
        throw new ReportPdfRowCapExceededError(
          REPORT_PDF_ROW_CAP,
          computed.rows.length,
        );
      }
      return this.runBounded(
        timeoutMs,
        async (signal, remainingMs) => {
          const html = renderReportHtml(computed, { signal, remainingMs });
          const effectiveTimeout = Math.min(
            timeoutMs,
            Math.max(0, remainingMs()),
          );
          const pdfBuffer = await this.pdfRenderer.renderHtmlToPdf(html, {
            timeoutMs: effectiveTimeout,
            signal,
          });
          return {
            content: pdfBuffer,
            contentType: 'application/pdf',
            extension: 'pdf' as const,
          };
        },
        'Report rendering exceeded the delivery work cap.',
        this.renderSettleTimeoutMs,
      );
    }
    return this.runBounded(
      timeoutMs,
      async (signal, remainingMs) =>
        serializeReport(format, computed, {
          signal,
          remainingMs,
        }),
      'Report rendering exceeded the delivery work cap.',
      0,
    );
  }

  public async store(
    context: JobExecutionContext<ReportJobPayload>,
    rendered: unknown,
    timeoutMs: number,
  ): Promise<ReportJobComputed> {
    if (!isSerializedReport(rendered)) {
      throw new Error('Report store received an invalid rendered artifact.');
    }
    const artifact = rendered;
    return this.runBounded(
      timeoutMs,
      async (signal) => {
        await this.storage.upload(
          context.payload.objectKey,
          artifact.content,
          artifact.contentType,
          signal,
        );
        const completedAt = this.clock();
        const signature = await this.storage.sign(
          context.payload.objectKey,
          new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
          signal,
        );
        return {
          downloadUrl: signature.url,
          expiresAt: signature.expiresAt,
          completedAt,
        };
      },
      'Report storage exceeded the delivery work cap.',
      0,
    );
  }

  private async runBounded<T>(
    timeoutMs: number,
    work: (signal: AbortSignal, remainingMs: () => number) => Promise<T>,
    message: string,
    settleWaitMs = 0,
  ): Promise<T> {
    const controller = new AbortController();
    let remainingMs = (): number => Number.POSITIVE_INFINITY;
    let timer: NodeJS.Timeout | undefined;
    let fallbackTimer: NodeJS.Timeout | undefined;
    let workPromise: Promise<T> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      const deadlineAt = performance.now() + timeoutMs;
      remainingMs = () => deadlineAt - performance.now();
      timer = setTimeout(async () => {
        controller.abort();
        if (settleWaitMs > 0 && workPromise !== undefined) {
          const settled = workPromise.then(
            () => undefined,
            () => undefined,
          );
          const fallback = new Promise<void>((resolve) => {
            fallbackTimer = setTimeout(resolve, settleWaitMs);
          });
          await Promise.race([settled, fallback]);
        }
        reject(new DeliveryDeadlineExceededError(message));
      }, timeoutMs);
    });
    void timeout.catch(() => undefined);

    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (controller.signal.aborted) {
        throw new DeliveryDeadlineExceededError(message);
      }
      workPromise = work(controller.signal, remainingMs);
      return await Promise.race([
        workPromise.catch((error: unknown) => {
          if (controller.signal.aborted) {
            throw new DeliveryDeadlineExceededError(message, { cause: error });
          }
          throw error;
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    }
  }

  public async persist(
    context: JobExecutionContext<ReportJobPayload>,
    computed: ReportJobComputed,
    client: TransactionClient,
  ): Promise<string> {
    const role = await this.reports.readActiveRole(client, context.workspaceId);
    if (!isWriteRole(role)) {
      throw new ReportWriteForbiddenError();
    }
    await this.reports.beginProcessingReportRun(
      client,
      context.workspaceId,
      context.payload.reportRunId,
      context.jobId,
    );
    await this.reports.completeProcessingReportRun(
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
