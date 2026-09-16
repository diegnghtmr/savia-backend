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
import {
  parseExportJobPayload,
  ExportJobPayloadError,
  type ExportJobPayload,
} from './export-job-payload.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';
import { serialize } from './export-serializers.js';
import type { ExportRows } from './export.port.js';

const EXPORT_WRITE_ROLES = {
  OWNER: 'owner',
  ADMINISTRATOR: 'administrator',
  EDITOR: 'editor',
} as const;

type ExportWriteRole =
  (typeof EXPORT_WRITE_ROLES)[keyof typeof EXPORT_WRITE_ROLES];

const WRITE_ROLE_VALUES: readonly string[] = Object.values(EXPORT_WRITE_ROLES);

export class ExportWriteForbiddenError extends Error {
  public readonly isDomainError = true;
  public readonly type = PROBLEM_TYPES.FORBIDDEN;
  public readonly title = 'Forbidden';
  public readonly status = 403;
  public readonly code = 'forbidden';

  public constructor() {
    super('Workspace access forbidden');
    this.name = 'ExportWriteForbiddenError';
  }
}

function isWriteRole(role: string | undefined): role is ExportWriteRole {
  return WRITE_ROLE_VALUES.includes(role ?? '');
}

export interface SerializedExport {
  readonly content: Buffer;
  readonly contentType: string;
  readonly extension: string;
}

function isSerializedExport(value: unknown): value is SerializedExport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SerializedExport>;
  return (
    Buffer.isBuffer(candidate.content) &&
    typeof candidate.contentType === 'string' &&
    typeof candidate.extension === 'string'
  );
}

export interface ExportJobComputed {
  readonly downloadUrl: string;
  readonly expiresAt: Date;
  readonly completedAt: Date;
  readonly objectPath: string;
}

@Injectable()
export class ExportJobHandler
  implements JobHandler<ExportJobPayload, ExportRows, ExportJobComputed>
{
  public readonly jobType = JOB_WRITER_TYPES.EXPORT_JOB;

  public constructor(
    private readonly exports: PostgresExportAdapter,
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public parsePayload(
    raw: unknown,
    execution?: Pick<JobExecutionContext<unknown>, 'workspaceId'>,
  ): ExportJobPayload {
    return parseExportJobPayload(raw, execution?.workspaceId);
  }

  public async compute(
    context: JobExecutionContext<ExportJobPayload>,
    client: TransactionClient,
  ): Promise<ExportRows> {
    const payload = context.payload;
    const binding = await this.exports.readExportJobBinding(
      client,
      context.workspaceId,
      payload.exportJobId,
    );
    if (
      binding === undefined ||
      binding.jobId !== context.jobId ||
      (binding.status !== 'queued' && binding.status !== 'processing')
    ) {
      throw new ExportJobPayloadError(
        'Export job payload exportJobId is not bound to this job.',
      );
    }
    return this.exports.readRows(client, context.workspaceId, {
      format: payload.format,
      resource: payload.resource,
      resourceId: payload.resourceId,
      from: payload.from,
      to: payload.to,
    });
  }

  public async render(
    context: JobExecutionContext<ExportJobPayload>,
    computed: ExportRows,
    timeoutMs: number,
  ): Promise<SerializedExport> {
    return this.runBounded(
      timeoutMs,
      async (signal, remainingMs) =>
        serialize(context.payload.format, computed, {
          signal,
          remainingMs,
          asOf: context.payload.asOf,
        }),
      'Export rendering exceeded the delivery work cap.',
    );
  }

  public async store(
    context: JobExecutionContext<ExportJobPayload>,
    rendered: unknown,
    timeoutMs: number,
  ): Promise<ExportJobComputed> {
    if (!isSerializedExport(rendered)) {
      throw new Error('Export store received an invalid rendered artifact.');
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
          objectPath: context.payload.objectKey,
        };
      },
      'Export storage exceeded the delivery work cap.',
    );
  }

  private async runBounded<T>(
    timeoutMs: number,
    work: (signal: AbortSignal, remainingMs: () => number) => Promise<T>,
    message: string,
  ): Promise<T> {
    const controller = new AbortController();
    let remainingMs = (): number => Number.POSITIVE_INFINITY;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((_, reject) => {
      const deadlineAt = performance.now() + timeoutMs;
      remainingMs = () => deadlineAt - performance.now();
      timer = setTimeout(() => {
        controller.abort();
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
      return await Promise.race([
        work(controller.signal, remainingMs).catch((error: unknown) => {
          if (controller.signal.aborted) {
            throw new DeliveryDeadlineExceededError(message, { cause: error });
          }
          throw error;
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async persist(
    context: JobExecutionContext<ExportJobPayload>,
    computed: ExportJobComputed,
    client: TransactionClient,
  ): Promise<string> {
    const role = await this.exports.readActiveRole(client, context.workspaceId);
    if (!isWriteRole(role)) {
      throw new ExportWriteForbiddenError();
    }
    await this.exports.beginProcessingExportJob(
      client,
      context.workspaceId,
      context.payload.exportJobId,
      context.jobId,
    );
    await this.exports.completeProcessingExportJob(
      client,
      context.workspaceId,
      context.payload.exportJobId,
      context.jobId,
      {
        objectPath: computed.objectPath,
        downloadUrl: computed.downloadUrl,
        expiresAt: computed.expiresAt,
        completedAt: computed.completedAt,
      },
    );
    return context.payload.exportJobId;
  }
}
