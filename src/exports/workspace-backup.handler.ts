import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ARTIFACT_STORAGE,
  type ArtifactStorage,
} from '../platform/artifact-storage.port.js';
import { DeliveryDeadlineExceededError } from '../platform/delivery-deadline.js';
import {
  JOB_RENDER_BUDGETS,
  type JobExecutionContext,
  type RenderingJobHandler,
} from '../platform/job-handler.port.js';
import { JOB_WRITER_TYPES } from '../platform/job-writer.port.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  BackupArtifactError,
  renderWorkspaceBackup,
} from './workspace-backup-archive.js';
import {
  readBackupSnapshot,
  type BackupPayload,
  type BackupSnapshot,
} from './workspace-backup-snapshot.js';

type Context = JobExecutionContext<BackupPayload>;
interface Signature {
  readonly url: string;
  readonly expiresAt: Date;
}
const LINK_LIFETIME_MS = 15 * 60_000;

async function bounded<T>(
  timeoutMs: number,
  work: (signal: AbortSignal, remainingMs: () => number) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.timeout(Math.max(0, Math.floor(timeoutMs)));
  const remainingMs = () => deadline - performance.now();
  try {
    const result = await work(signal, remainingMs);
    if (!signal.aborted && remainingMs() > 0) return result;
  } catch (error) {
    if (!signal.aborted && remainingMs() > 0) throw error;
  }
  throw new DeliveryDeadlineExceededError(
    'Workspace backup exceeded the delivery work cap.',
  );
}

@Injectable()
export class WorkspaceBackupHandler
  implements RenderingJobHandler<BackupPayload, BackupSnapshot, Signature>
{
  public readonly jobType = JOB_WRITER_TYPES.WORKSPACE_BACKUP;
  public readonly renderBudget = JOB_RENDER_BUDGETS.EXPORT_SERIALIZE;

  public constructor(
    @Inject(ARTIFACT_STORAGE) private readonly storage: ArtifactStorage,
  ) {}

  public parsePayload(raw: unknown): BackupPayload {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'version' in raw &&
      raw.version === 1 &&
      'backupId' in raw &&
      typeof raw.backupId === 'string' &&
      UUID_PATTERN.test(raw.backupId)
    ) {
      return { backupId: raw.backupId };
    }
    throw new BackupArtifactError('Invalid workspace backup job payload.');
  }

  public async compute(
    context: Context,
    client: TransactionClient,
  ): Promise<BackupSnapshot> {
    const snapshot = await readBackupSnapshot(client, context);
    if (!snapshot) {
      throw new BackupArtifactError(
        'Workspace backup is not available to the requesting owner.',
      );
    }
    return snapshot;
  }

  public async render(
    context: Context,
    snapshot: BackupSnapshot,
    timeoutMs: number,
  ): Promise<Buffer> {
    return bounded(timeoutMs, (signal, remainingMs) =>
      renderWorkspaceBackup(context.workspaceId, snapshot, this.storage, {
        signal,
        remainingMs,
      }),
    );
  }

  public async store(
    context: Context,
    rendered: unknown,
    timeoutMs: number,
  ): Promise<Signature> {
    if (!Buffer.isBuffer(rendered)) {
      throw new BackupArtifactError('Invalid workspace backup artifact.');
    }
    // The exports bucket is private. Its legacy workspace-reader policy only
    // matches paths starting with a workspace UUID, never the backups/ prefix.
    // A separate key per attempt prevents a stale upload overwriting a signed ZIP.
    const path = `backups/${context.workspaceId}/${context.payload.backupId}/${randomUUID()}.zip`;
    return bounded(timeoutMs, async (signal) => {
      await this.storage.upload(path, rendered, 'application/zip', signal);
      signal.throwIfAborted();
      const requestedExpiry = new Date(Date.now() + LINK_LIFETIME_MS);
      const { url, expiresAt } = await this.storage.sign(
        path,
        requestedExpiry,
        signal,
      );
      const parsed = URL.parse(url);
      if (
        !url.startsWith('https://') ||
        parsed?.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        !parsed.pathname.endsWith(`/${path}`) ||
        !parsed.searchParams.get('token') ||
        !(expiresAt.getTime() > Date.now()) ||
        expiresAt.getTime() > requestedExpiry.getTime() + 1000
      ) {
        throw new BackupArtifactError('Invalid workspace backup signature.');
      }
      return { url, expiresAt };
    });
  }

  public async persist(
    context: Context,
    signature: Signature,
    client: TransactionClient,
  ): Promise<null> {
    // The shared runner commits this update and its processing→completed
    // transition in the same transaction. No in-progress signature is public.
    const result = await client.query(
      `update public.workspace_backups b set download_url = $6, expires_at = $7
         from public.jobs j
        where b.id = $1::uuid and b.workspace_id = $2::uuid and b.job_id = $3::uuid
          and b.created_by = $4::uuid and b.download_url is null
          and (j.workspace_id, j.id, j.created_by) = (b.workspace_id, b.job_id, b.created_by)
          and j.type = 'workspace_backup' and j.status = 'processing' and j.attempt_count = $5
        returning b.id`,
      [
        context.payload.backupId,
        context.workspaceId,
        context.jobId,
        context.actorId,
        context.attemptCount,
        signature.url,
        signature.expiresAt,
      ],
    );
    if (!result.rowCount) {
      throw new DeliveryDeadlineExceededError(
        'Workspace backup attempt no longer owns completion.',
      );
    }
    return null;
  }
}
