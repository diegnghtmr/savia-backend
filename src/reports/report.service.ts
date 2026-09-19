import { randomUUID } from 'node:crypto';
import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { JobWriter } from '../platform/job-writer.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  resolveReportPeriod,
  resolveShapeTypeFilter,
  type ReportComputationShape,
} from './report-computation.js';
import { REPORT_PRESETS } from './report-presets.js';
import {
  freezeReportJobPayload,
  REPORT_JOB_PAYLOAD_VERSION,
} from './report-job-payload.js';
import { reportArtifactObjectKey } from './report-run-snapshot.js';
import {
  REPORT_OUTCOMES,
  type CreateReportDefinitionRequest,
  type ReportCreateOutcome,
  type ReportListOutcome,
  type ReportListQuery,
  type ReportStore,
  type ReportsPort,
  REPORT_RUN_OUTCOMES,
  type CreateReportRunRequest,
  type ReportRunCreateOutcome,
  type ReportRunGetOutcome,
} from './report.port.js';

export interface ReportTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ReportDefinitionCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Report definition create transaction must be rolled back.');
    this.name = 'ReportDefinitionCreateRollbackError';
  }
}

export class ReportRunCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Report run create transaction must be rolled back.');
    this.name = 'ReportRunCreateRollbackError';
  }
}

export class ReportService implements ReportsPort {
  public constructor(
    private readonly tx: ReportTransaction,
    private readonly store: ReportStore,
    private readonly idempotency: IdempotencyStore,
    private readonly jobs: JobWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async createReportDefinition(
    subject: string,
    workspaceId: string,
    command: CreateReportDefinitionRequest,
    key: string,
  ): Promise<ReportCreateOutcome> {
    const route = 'POST /v1/report-definitions';
    const fingerprint = computeRequestFingerprint(command);

    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: REPORT_OUTCOMES.FORBIDDEN };
        }

        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: REPORT_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: REPORT_OUTCOMES.CONFLICT };
        }

        const reportDefinition = await this.store.createReportDefinition(
          client,
          workspaceId,
          subject,
          command,
        );

        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          201,
          null,
          reportDefinition,
          workspaceId,
        );

        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new ReportDefinitionCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new ReportDefinitionCreateRollbackError('conflict');
          }
          throw new Error(
            'Report definition idempotency record could not be reread.',
          );
        }

        return { kind: REPORT_OUTCOMES.CREATED, reportDefinition };
      });
    } catch (error) {
      if (error instanceof ReportDefinitionCreateRollbackError) {
        if (error.outcome === 'replayed') {
          return {
            kind: REPORT_OUTCOMES.REPLAYED,
            status: error.status ?? 201,
            etag: error.etag ?? null,
            body: error.body,
          };
        }
        return { kind: REPORT_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }

  public async listReportDefinitions(
    subject: string,
    query: ReportListQuery,
  ): Promise<ReportListOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (
        !['owner', 'administrator', 'editor', 'viewer'].includes(role ?? '')
      ) {
        return { kind: REPORT_OUTCOMES.FORBIDDEN };
      }

      const rows = await this.store.listReportDefinitions(
        client,
        query,
        query.limit + 1,
      );
      const hasNextPage = rows.length > query.limit;
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const last = visible[visible.length - 1];

      return {
        kind: 'ok',
        page: {
          items: visible.map((r) => r.reportDefinition),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last
                ? encodeCursor({
                    workspaceId: query.workspaceId,
                    createdAt: last.cursorAt,
                    id: last.reportDefinition.id,
                  })
                : null,
          },
        },
      };
    });
  }

  public async createReportRun(
    subject: string,
    workspaceId: string,
    command: CreateReportRunRequest,
    key: string,
  ): Promise<ReportRunCreateOutcome> {
    const route = 'POST /v1/report-runs';
    const fingerprint = computeRequestFingerprint(command);
    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? '')) {
          return { kind: REPORT_RUN_OUTCOMES.FORBIDDEN };
        }
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? {
                kind: REPORT_RUN_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              }
            : { kind: REPORT_RUN_OUTCOMES.CONFLICT };
        }
        const shape = command.definitionId
          ? await this.store.readReportDefinition!(
              client,
              workspaceId,
              command.definitionId,
            )
          : command.preset
            ? REPORT_PRESETS[command.preset as keyof typeof REPORT_PRESETS]
            : undefined;
        if (!shape) {
          return {
            kind: REPORT_RUN_OUTCOMES.UNPROCESSABLE,
            violations: [
              {
                field: 'definitionId',
                message: 'Report definition was not found.',
              },
            ],
          };
        }
        const computationShape = shape as ReportComputationShape;
        const defFilters =
          'filters' in shape &&
          typeof shape.filters === 'object' &&
          shape.filters !== null
            ? (shape.filters as Record<string, unknown>)
            : undefined;
        const now = this.clock();
        const { periodStart, periodTo } = resolveReportPeriod(
          now,
          defFilters,
          command.filters,
        );
        const baseCurrency = await this.store.readWorkspaceBaseCurrency!(
          client,
          workspaceId,
        );
        if (!baseCurrency) {
          return { kind: REPORT_RUN_OUTCOMES.FORBIDDEN };
        }
        const reportRunId = randomUUID();
        const objectKey = reportArtifactObjectKey(
          workspaceId,
          reportRunId,
          command.format,
        );
        const jobRecord = await this.jobs.createQueuedJob(
          client,
          workspaceId,
          subject,
          JOB_WRITER_TYPES.REPORT_RUN,
          freezeReportJobPayload({
            version: REPORT_JOB_PAYLOAD_VERSION,
            asOf: now.toISOString(),
            reportRunId,
            format: command.format,
            definitionId: command.definitionId ?? null,
            preset: command.preset ?? null,
            filters: command.filters,
            periodStart,
            periodTo,
            shapeTypeFilter: resolveShapeTypeFilter(computationShape) ?? null,
            callerType:
              typeof command.filters.type === 'string'
                ? command.filters.type
                : null,
            dimensions: [...shape.dimensions],
            measures: [...shape.measures],
            objectKey,
            baseCurrency,
          }),
        );
        const jobId = String(jobRecord.id);
        const created = await this.store.insertQueuedReportRun!(
          client,
          workspaceId,
          subject,
          {
            id: reportRunId,
            definitionId: command.definitionId ?? null,
            preset: command.preset ?? null,
            format: command.format,
            filters: command.filters,
            snapshotId: jobId,
            jobId,
          },
        );
        const written = await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          202,
          null,
          created,
          workspaceId,
        );
        if (!written) {
          const reread = await this.idempotency.read(
            client,
            subject,
            route,
            key,
            workspaceId,
          );
          if (reread?.requestFingerprint === fingerprint) {
            throw new ReportRunCreateRollbackError(
              'replayed',
              reread.responseStatus,
              reread.responseEtag,
              reread.responseBody,
            );
          }
          if (reread) throw new ReportRunCreateRollbackError('conflict');
          throw new Error('Report run idempotency record could not be reread.');
        }
        return { kind: REPORT_RUN_OUTCOMES.CREATED, reportRun: created };
      });
    } catch (error) {
      if (error instanceof ReportRunCreateRollbackError) {
        return error.outcome === 'replayed'
          ? {
              kind: REPORT_RUN_OUTCOMES.REPLAYED,
              status: error.status ?? 202,
              etag: error.etag ?? null,
              body: error.body,
            }
          : { kind: REPORT_RUN_OUTCOMES.CONFLICT };
      }
      throw error;
    }
  }

  public async getReportRun(
    subject: string,
    workspaceId: string,
    reportRunId: string,
  ): Promise<ReportRunGetOutcome> {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (!['owner', 'administrator', 'editor', 'viewer'].includes(role ?? ''))
        return { kind: REPORT_RUN_OUTCOMES.FORBIDDEN };
      const reportRun = await this.store.findReportRun!(
        client,
        workspaceId,
        reportRunId,
      );
      return reportRun
        ? { kind: REPORT_RUN_OUTCOMES.OK, reportRun }
        : { kind: REPORT_RUN_OUTCOMES.NOT_FOUND };
    });
  }
}
