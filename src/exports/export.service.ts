import type { IdempotencyStore } from '../platform/idempotency.port.js';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { CommitOutcomeUnknownError } from '../platform/pg-transaction.js';
import {
  EXPORT_OUTCOMES,
  type CreateExportJobCommand,
  type ExportCreateOutcome,
  type ExportGetOutcome,
  type ExportStorage,
  type ExportStore,
  type ExportsPort,
} from './export.port.js';
import { serialize } from './export-serializers.js';
import { ExportUnrepresentableError } from './postgres-export.adapter.js';
const READ_ROLES = ['owner', 'administrator', 'editor', 'viewer'];
const WRITE_ROLES = ['owner', 'administrator', 'editor'];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
class ExportFailure extends Error {
  public constructor(public readonly problem: Record<string, unknown>) {
    super('Export generation failed.');
  }
}
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
export class ExportService implements ExportsPort {
  public constructor(
    private readonly transaction: ExportTransaction,
    private readonly store: ExportStore,
    private readonly idempotency: IdempotencyStore,
    private readonly storage: ExportStorage,
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
    )
      return { kind: EXPORT_OUTCOMES.UNSUPPORTED_RESOURCE };
    const route = 'POST /v1/export-jobs';
    const fingerprint = computeRequestFingerprint(command);
    let reservedId: string | undefined;
    let uploadedPath: string | undefined;
    try {
      const prepared = await this.transaction.run(subject, async (client) => {
        const role = await this.store.readActiveRole(client, workspaceId);
        if (!role || !WRITE_ROLES.includes(role))
          return { kind: EXPORT_OUTCOMES.FORBIDDEN };
        const existing = await this.idempotency.read(
          client,
          subject,
          route,
          key,
          workspaceId,
        );
        if (existing)
          return existing.requestFingerprint === fingerprint
            ? {
                kind: EXPORT_OUTCOMES.REPLAYED,
                status: existing.responseStatus,
                body: existing.responseBody,
              }
            : { kind: EXPORT_OUTCOMES.IDEMPOTENCY_CONFLICT };
        const id = this.store.createId();
        const path = `${workspaceId}/${id}.${command.format === 'json_backup' ? 'json' : command.format}`;
        const rows = await this.store.readRows(client, workspaceId, command);
        const artifact = await serialize(command.format, rows);
        const job = await this.store.reserve(client, workspaceId, subject, id, command, path);
        reservedId = id;
        return { job, artifact, path };
      });
      if (!('artifact' in prepared)) return prepared;
      uploadedPath = prepared.path!;
      await this.storage.upload(uploadedPath, prepared.artifact!.content, prepared.artifact!.contentType);
      const signature = await this.storage.sign(uploadedPath, new Date(Date.now() + TTL_MS));
      const job = await this.transaction.run(subject, async (client) => {
        const completed = await this.store.complete(client, workspaceId, reservedId!, signature.url, signature.expiresAt.toISOString());
        const written = await this.idempotency.write(client, subject, route, key, fingerprint, 202, null, completed, workspaceId);
        if (!written) throw new Error('Idempotency record was lost after export completion.');
        return completed;
      });
      return { kind: EXPORT_OUTCOMES.CREATED, job };
    } catch (error) {
      if (error instanceof ExportUnrepresentableError)
        return { kind: EXPORT_OUTCOMES.UNREPRESENTABLE, detail: error.message };
      if (error instanceof CommitOutcomeUnknownError) {
        const recovered = await this.transaction.runRead(subject, (client) =>
          this.idempotency.read(client, subject, route, key, workspaceId),
        );
        if (recovered?.requestFingerprint === fingerprint)
          return { kind: EXPORT_OUTCOMES.REPLAYED, status: recovered.responseStatus, body: recovered.responseBody };
        throw error;
      }
      if (uploadedPath !== undefined) await this.storage.remove(uploadedPath);
      const problem =
        error instanceof ExportFailure
          ? error.problem
          : {
              type: 'https://savia.app/problems/export-failed',
              title: 'Export failed',
              status: 422,
              code: 'export-failed',
              traceId: 'export',
              detail:
                error instanceof Error
                  ? error.message
                  : 'Export could not be generated.',
            };
      const job = await this.transaction.run(subject, async (client) => {
        const failedJob = reservedId
          ? await this.store.fail(client, workspaceId, reservedId, problem)
          : await this.store.insert(client, workspaceId, subject, this.store.createId(), command, '', null, null, problem);
        await this.idempotency.write(
          client,
          subject,
          route,
          key,
          fingerprint,
          202,
          null,
          failedJob,
          workspaceId,
        );
        return failedJob;
      });
      return { kind: EXPORT_OUTCOMES.FAILED, job };
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
