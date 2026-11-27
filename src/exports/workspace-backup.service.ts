import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { computeRequestFingerprint } from '../platform/idempotency.service.js';
import {
  JOB_WRITER,
  JOB_WRITER_TYPES,
  type JobWriter,
} from '../platform/job-writer.port.js';
import { PgTransaction } from '../platform/pg-transaction.js';
import { PostgresIdempotencyAdapter } from '../platform/postgres-idempotency.adapter.js';
import { PostgresExportAdapter } from './postgres-export.adapter.js';

interface WorkspaceBackupJob {
  readonly id: string;
  readonly status: 'queued' | 'processing' | 'completed' | 'failed';
  readonly createdAt: string;
  readonly downloadUrl: string | null;
  readonly expiresAt: string | null;
}

interface BackupRow extends Record<string, unknown> {
  readonly status: string;
  readonly created_at: Date;
  readonly download_url: string | null;
  readonly expires_at: Date | null;
}

const ROUTE = 'POST /v1/backup-jobs';
const FINGERPRINT = computeRequestFingerprint({});

class BackupReplay extends Error {
  public constructor(public readonly body: unknown) {
    super('Concurrent workspace backup creation must roll back.');
  }
}

@Injectable()
export class WorkspaceBackupService {
  public constructor(
    private readonly tx: PgTransaction,
    private readonly exports: PostgresExportAdapter,
    private readonly idempotency: PostgresIdempotencyAdapter,
    @Inject(JOB_WRITER) private readonly jobs: JobWriter,
  ) {}

  public async create(subject: string, workspace: string, key: string) {
    try {
      return await this.tx.run(subject, async (client) => {
        const role = await this.exports.readActiveRole(client, workspace);
        if (role !== 'owner') return { kind: 'forbidden' as const };
        const read = () =>
          this.idempotency.read(client, subject, ROUTE, key, workspace);
        const existing = await read();
        if (existing) {
          return existing.requestFingerprint === FINGERPRINT
            ? { kind: 'accepted' as const, body: existing.responseBody }
            : { kind: 'conflict' as const };
        }

        const id = randomUUID();
        const queued = await this.jobs.createQueuedJob(
          client,
          workspace,
          subject,
          JOB_WRITER_TYPES.WORKSPACE_BACKUP,
          { version: 1, backupId: id },
        );
        await client.query(
          `insert into public.workspace_backups (id, workspace_id, job_id, created_by)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
          [id, workspace, queued.id, subject],
        );
        const body: WorkspaceBackupJob = {
          id,
          status: 'queued',
          createdAt: queued.createdAt,
          downloadUrl: null,
          expiresAt: null,
        };
        const written = await this.idempotency.write(
          client,
          subject,
          ROUTE,
          key,
          FINGERPRINT,
          202,
          null,
          body,
          workspace,
        );
        if (written) return { kind: 'accepted' as const, body };
        const winner = await read();
        if (!winner) {
          throw new Error('Workspace backup idempotency winner not found.');
        }
        throw new BackupReplay(
          winner.requestFingerprint === FINGERPRINT
            ? winner.responseBody
            : undefined,
        );
      });
    } catch (error) {
      if (!(error instanceof BackupReplay)) throw error;
      return error.body === undefined
        ? { kind: 'conflict' as const }
        : { kind: 'accepted' as const, body: error.body };
    }
  }

  public async get(subject: string, workspace: string, id: string) {
    return this.tx.runRead(subject, async (client) => {
      const role = await this.exports.readActiveRole(client, workspace);
      if (role !== 'owner') return { kind: 'forbidden' as const };
      const { rows } = await client.query<BackupRow>(
        `select j.status, j.created_at, b.download_url, b.expires_at
           from public.workspace_backups b
           join public.jobs j on (j.workspace_id, j.id, j.created_by) =
                                 (b.workspace_id, b.job_id, b.created_by)
          where b.workspace_id = $1::uuid and b.id = $2::uuid
            and b.created_by = $3::uuid and j.type = 'workspace_backup'`,
        [workspace, id, subject],
      );
      const row = rows[0];
      if (!row) return { kind: 'not-found' as const };
      const status =
        row.status === 'queued' ||
        row.status === 'processing' ||
        row.status === 'completed'
          ? row.status
          : 'failed';
      const expiresAt = row.expires_at;
      const live =
        status === 'completed' &&
        row.download_url !== null &&
        expiresAt !== null &&
        expiresAt.getTime() > Date.now();
      const body: WorkspaceBackupJob = {
        id,
        status,
        createdAt: row.created_at.toISOString(),
        downloadUrl: live ? row.download_url : null,
        expiresAt: live ? expiresAt.toISOString() : null,
      };
      return { kind: 'found' as const, body };
    });
  }
}
