import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { JobWriter } from '../platform/job-writer.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import {
  EXPORT_OUTCOMES,
  type CreateExportJobCommand,
  type ExportCreateOutcome,
  type ExportGetOutcome,
  type ExportStore,
  type ExportsPort,
} from './export.port.js';
import {
  exportArtifactObjectKey,
  freezeExportJobPayload,
  EXPORT_JOB_PAYLOAD_VERSION,
} from './export-job-payload.js';

const READ_ROLES = ['owner', 'administrator', 'editor', 'viewer'];
const WRITE_ROLES = ['owner', 'administrator', 'editor'];

export interface ExportTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export class ExportJobCreateRollbackError extends Error {
  public constructor(
    public readonly outcome: 'replayed' | 'conflict',
    public readonly status?: number,
    public readonly etag?: string | null,
    public readonly body?: unknown,
  ) {
    super('Export job create transaction must be rolled back.');
    this.name = 'ExportJobCreateRollbackError';
  }
}

export class ExportService implements ExportsPort {
  public constructor(
    private readonly transaction: ExportTransaction,
    private readonly store: ExportStore,
    private readonly idempotency: IdempotencyStore,
    private readonly jobs: JobWriter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async createExportJob(
    subject: string,
    workspaceId: string,
    command: CreateExportJobCommand,
    key: string,
  ): Promise<ExportCreateOutcome> {
    if (
      command.resource === 'budgets' ||
      command.resource === 'debts' ||
      command.resource === 'report'
    ) {
      return { kind: EXPORT_OUTCOMES.UNSUPPORTED_RESOURCE };
    }

    const route = 'POST /v1/export-jobs';
    const fingerprint = computeRequestFingerprint(command);

    try {
      return await this.transaction.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!role || !WRITE_ROLES.includes(role)) {
          return { kind: EXPORT_OUTCOMES.FORBIDDEN };
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
                kind: EXPORT_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                body: existing.responseBody,
              }
            : { kind: EXPORT_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }

        const id = this.store.createId();
        const now = this.clock();
        const objectKey = exportArtifactObjectKey(
          workspaceId,
          id,
          command.format,
        );

        const jobRecord = await this.jobs.createQueuedJob(
          client,
          workspaceId,
          subject,
          JOB_WRITER_TYPES.EXPORT_JOB,
          freezeExportJobPayload({
            version: EXPORT_JOB_PAYLOAD_VERSION,
            asOf: now.toISOString(),
            exportJobId: id,
            format: command.format,
            resource: command.resource,
            resourceId: command.resourceId,
            from: command.from,
            to: command.to,
            objectKey,
          }),
        );
        const jobId = String(jobRecord.id);

        const created = this.store.insertQueuedExportJob
          ? await this.store.insertQueuedExportJob(
              client,
              workspaceId,
              subject,
              {
                id,
                format: command.format,
                resource: command.resource,
                resourceId: command.resourceId,
                from: command.from,
                to: command.to,
                jobId,
              },
            )
          : await this.store.reserve(
              client,
              workspaceId,
              subject,
              id,
              command,
              objectKey,
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
          if (reread) {
            if (reread.requestFingerprint === fingerprint) {
              throw new ExportJobCreateRollbackError(
                'replayed',
                reread.responseStatus,
                reread.responseEtag,
                reread.responseBody,
              );
            }
            throw new ExportJobCreateRollbackError('conflict');
          }
          throw new Error('Export job idempotency record could not be reread.');
        }

        return { kind: EXPORT_OUTCOMES.CREATED, job: created };
      });
    } catch (error) {
      if (error instanceof ExportJobCreateRollbackError) {
        if (error.outcome === 'replayed') {
          return {
            kind: EXPORT_OUTCOMES.REPLAYED,
            status: error.status ?? 202,
            body: error.body,
          };
        }
        return { kind: EXPORT_OUTCOMES.IDEMPOTENCY_CONFLICT };
      }
      throw error;
    }
  }

  public async getExportJob(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<ExportGetOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (!role || !READ_ROLES.includes(role)) return { kind: 'forbidden' };
      const job = await this.store.find(client, workspaceId, id);
      return job ? { kind: 'found', job } : { kind: 'not-found' };
    });
  }
}
