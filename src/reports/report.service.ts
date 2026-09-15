import { encodeCursor } from '../platform/cursor.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  REPORT_OUTCOMES,
  type CreateReportDefinitionRequest,
  type ReportCreateOutcome,
  type ReportListOutcome,
  type ReportListQuery,
  type ReportStore,
  type ReportsPort,
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

export class ReportService implements ReportsPort {
  public constructor(
    private readonly tx: ReportTransaction,
    private readonly store: ReportStore,
    private readonly idempotency: IdempotencyStore,
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
}
