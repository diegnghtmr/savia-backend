import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { randomUUID } from 'node:crypto';
import type { ArtifactStorage } from '../platform/artifact-storage.port.js';
import { computeReportGrid } from './report-engine.js';
import { REPORT_PRESETS } from './report-presets.js';
import { serializeReport } from './report-serializers.js';
import {
  ReportMissingRateError,
  ReportRowCapExceededError,
  ReportCellCapExceededError,
  ReportCellStringLengthExceededError,
} from './report.port.js';
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
    private readonly storage?: ArtifactStorage,
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
    let uploadedPath: string | undefined;
    try {
      const prepared = await this.tx.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!['owner', 'administrator', 'editor'].includes(role ?? ''))
          return { kind: REPORT_RUN_OUTCOMES.FORBIDDEN } as const;
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing) {
          return existing.requestFingerprint === fingerprint
            ? ({
                kind: REPORT_RUN_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                etag: existing.responseEtag,
                body: existing.responseBody,
              } as const)
            : ({ kind: REPORT_RUN_OUTCOMES.CONFLICT } as const);
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
        if (!shape)
          return {
            kind: REPORT_RUN_OUTCOMES.UNPROCESSABLE,
            violations: [
              {
                field: 'definitionId',
                message: 'Report definition was not found.',
              },
            ],
          } as const;
        const now = this.clock();
        const periodEnd = now.toISOString().slice(0, 10);
        const defaultStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
        )
          .toISOString()
          .slice(0, 10);
        const periodStart =
          typeof command.filters.from === 'string'
            ? command.filters.from
            : defaultStart;
        const to =
          typeof command.filters.to === 'string'
            ? command.filters.to
            : periodEnd;
        const callerType =
          typeof command.filters.type === 'string'
            ? command.filters.type
            : undefined;
        let rows;
        try {
          rows = await this.store.readReportSourceRows!(
            client,
            workspaceId,
            periodStart,
            to,
            'typeFilter' in shape ? shape.typeFilter : undefined,
            callerType,
          );
        } catch (error) {
          if (error instanceof ReportRowCapExceededError) {
            return {
              kind: REPORT_RUN_OUTCOMES.UNPROCESSABLE,
              detail: error.message,
              violations: [{ field: 'filters', message: error.message }],
            } as const;
          }
          throw error;
        }
        const baseCurrency = await this.store.readWorkspaceBaseCurrency!(
          client,
          workspaceId,
        );
        if (!baseCurrency)
          return { kind: REPORT_RUN_OUTCOMES.FORBIDDEN } as const;
        const budget = await this.store.readBudgetedMinorByBucket!(
          client,
          workspaceId,
          periodStart,
          to,
          shape.dimensions,
        );
        if (command.preset === 'budget' && budget.size === 0) {
          return {
            kind: REPORT_RUN_OUTCOMES.UNPROCESSABLE,
            detail: 'No budget exists for the requested period.',
            violations: [
              {
                field: 'preset',
                message: 'No budget exists for the requested period.',
              },
            ],
          } as const;
        }
        let grid;
        try {
          grid = computeReportGrid({
            rows,
            dimensions: shape.dimensions,
            measures: shape.measures,
            baseCurrency,
            budgetedMinorByBucket: budget,
          });
        } catch (error) {
          if (
            error instanceof ReportCellCapExceededError ||
            error instanceof ReportCellStringLengthExceededError
          ) {
            return {
              kind: REPORT_RUN_OUTCOMES.UNPROCESSABLE,
              detail: error.message,
              violations: [{ field: 'filters', message: error.message }],
            } as const;
          }
          throw error;
        }
        if (command.preset === 'budget') {
          const unbudgetedCount = grid.rows.filter(
            (r) => r.cells.find((c) => c.measure === 'budget')?.value === null,
          ).length;
          if (unbudgetedCount > 0) {
            const warningMessage = `${unbudgetedCount} ${unbudgetedCount === 1 ? 'bucket had' : 'buckets had'} no budget.`;
            grid = {
              ...grid,
              warnings: [...grid.warnings, warningMessage],
            };
          }
        }
        return { kind: 'prepared' as const, grid, shape, periodStart, to };
      });
      if (prepared.kind !== 'prepared') return prepared;
      if (!this.storage)
        throw new Error('Report artifact storage is not configured.');
      const reportRunId = randomUUID();
      uploadedPath = `${workspaceId}/${reportRunId}.${command.format}`;
      const artifact = await serializeReport(command.format, prepared.grid);
      await this.storage.upload(
        uploadedPath,
        artifact.content,
        artifact.contentType,
      );
      const signature = await this.storage.sign(
        uploadedPath,
        new Date(this.clock().getTime() + 7 * 24 * 60 * 60 * 1000),
      );
      const snapshotId = randomUUID();
      const reportRun = await this.tx.run(subject, async (client) => {
        const created = await this.store.insertReportRun!(
          client,
          workspaceId,
          subject,
          {
            id: reportRunId,
            definitionId: command.definitionId ?? null,
            preset: command.preset ?? null,
            format: command.format,
            filters: command.filters,
            snapshotId,
            downloadUrl: signature.url,
            expiresAt: signature.expiresAt,
            completedAt: this.clock(),
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
          if (reread?.requestFingerprint === fingerprint)
            throw new ReportRunCreateRollbackError(
              'replayed',
              reread.responseStatus,
              reread.responseEtag,
              reread.responseBody,
            );
          if (reread) throw new ReportRunCreateRollbackError('conflict');
          throw new Error('Report run idempotency record could not be reread.');
        }
        return created;
      });
      return { kind: REPORT_RUN_OUTCOMES.CREATED, reportRun };
    } catch (error) {
      if (uploadedPath !== undefined && this.storage) {
        try {
          await this.storage.remove(uploadedPath);
        } catch {
          // Best-effort cleanup must never mask or replace the primary error
        }
      }
      if (error instanceof ReportMissingRateError)
        return {
          kind: REPORT_RUN_OUTCOMES.MISSING_RATE,
          fromCurrency: error.fromCurrency,
          toCurrency: error.toCurrency,
        };
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
