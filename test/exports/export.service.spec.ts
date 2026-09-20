import { describe, expect, it } from 'vitest';
import { ExportService } from '../../src/exports/export.service.js';
import {
  type ExportJob,
  type ExportStore,
} from '../../src/exports/export.port.js';
import {
  type IdempotencyRecord,
  type IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { JobWriter } from '../../src/platform/job-writer.port.js';

const subject = '00000000-0000-0000-0000-000000000001';
const workspace = '00000000-0000-0000-0000-000000000002';
const fixedDate = new Date('2026-09-16T12:00:00.000Z');
const command = {
  format: 'csv' as const,
  resource: 'all' as const,
  resourceId: null,
  from: null,
  to: null,
};
const job = (
  id: string,
  status: ExportJob['status'] = 'queued',
): ExportJob => ({
  id,
  status,
  format: 'csv',
  downloadUrl: null,
  expiresAt: null,
  createdAt: '2026-09-16T12:00:00.000Z',
});

function harness(options?: { failIdempotencyWrite?: boolean }) {
  const records = new Map<string, IdempotencyRecord>();
  let exportJobsCreated = 0;
  let queuedJobsCreated = 0;
  const store: ExportStore = {
    readActiveRole: async () => 'owner',
    createId: () =>
      `00000000-0000-0000-0000-00000000000${exportJobsCreated + 3}`,
    reserve: async (_client, _ws, _subject, id) => {
      exportJobsCreated += 1;
      return job(id, 'queued');
    },
    insertQueuedExportJob: async (_client, _ws, _subject, data) => {
      exportJobsCreated += 1;
      return job(data.id, 'queued');
    },
    complete: async () => job('1', 'completed'),
    fail: async () => job('1', 'failed'),
    readRows: async () => ({ accounts: [], transactions: [] }),
    insert: async () => job('1'),
    find: async () => undefined,
  };
  const idempotency: IdempotencyStore = {
    read: async (_client, _subject, _route, key) => records.get(key),
    write: async (
      _client,
      _subject,
      _route,
      key,
      fingerprint,
      status,
      etag,
      body,
    ) => {
      if (options?.failIdempotencyWrite) return false;
      if (records.has(key)) return false;
      records.set(key, {
        requestFingerprint: fingerprint,
        responseStatus: status,
        responseEtag: etag,
        responseBody: body,
      });
      return true;
    },
  };
  const mockJobRecord = {
    id: 'job-1',
    type: 'export_job',
    status: 'queued',
    progressPercent: null,
    resultResourceId: null,
    error: null,
    createdAt: '2026-09-16T12:00:00.000Z',
    startedAt: null,
    completedAt: null,
  };
  const jobs: JobWriter = {
    createTerminalJob: async () => ({ ...mockJobRecord, status: 'completed' }),
    createQueuedJob: async (_client, _ws, _subj, _type, payload) => {
      queuedJobsCreated += 1;
      return {
        ...mockJobRecord,
        payload,
      };
    },
    transitionToProcessing: async () => ({
      ...mockJobRecord,
      status: 'processing',
    }),
    completeJob: async () => ({ ...mockJobRecord, status: 'completed' }),
    failJob: async () => ({ ...mockJobRecord, status: 'failed' }),
    deadLetter: async () => ({ ...mockJobRecord, status: 'dead_letter' }),
    findJobById: async () => undefined,
  };
  const transaction = {
    run: async <T>(
      _subject: string,
      callback: (client: { query: () => Promise<never> }) => Promise<T>,
    ) =>
      callback({
        query: async () => {
          throw new Error('not used');
        },
      }),
    runRead: async <T>(
      _subject: string,
      callback: (client: { query: () => Promise<never> }) => Promise<T>,
    ) =>
      callback({
        query: async () => {
          throw new Error('not used');
        },
      }),
  };
  return {
    service: new ExportService(
      transaction,
      store,
      idempotency,
      jobs,
      () => fixedDate,
    ),
    counts: () => ({ exportJobsCreated, queuedJobsCreated }),
  };
}

describe('ExportService', () => {
  it('enqueues an export job without in-request upload and replays idempotent requests', async () => {
    const h = harness();
    const first = await h.service.createExportJob(
      subject,
      workspace,
      command,
      'key-1',
    );
    const second = await h.service.createExportJob(
      subject,
      workspace,
      command,
      'key-1',
    );
    expect(first.kind).toBe('created');
    if (first.kind === 'created') {
      expect(first.job.status).toBe('queued');
      expect(first.job.downloadUrl).toBeNull();
    }
    expect(second.kind).toBe('replayed');
    expect(h.counts()).toMatchObject({
      exportJobsCreated: 1,
      queuedJobsCreated: 1,
    });
  });

  it('rejects unsupported resources synchronously without creating a job', async () => {
    const h = harness();
    const outcome = await h.service.createExportJob(
      subject,
      workspace,
      { ...command, resource: 'budgets' },
      'key-unsupported',
    );
    expect(outcome.kind).toBe('unsupported-resource');
    expect(h.counts()).toMatchObject({
      exportJobsCreated: 0,
      queuedJobsCreated: 0,
    });
  });

  it('returns forbidden when caller does not have an active write role', async () => {
    const h = harness();
    h.service = new ExportService(
      {
        run: async (_s, cb) =>
          cb({
            query: async () => {
              throw new Error('not used');
            },
          }),
        runRead: async (_s, cb) =>
          cb({
            query: async () => {
              throw new Error('not used');
            },
          }),
      },
      {
        readActiveRole: async () => 'viewer',
        createId: () => 'id-1',
        reserve: async () => job('1'),
        complete: async () => job('1'),
        fail: async () => job('1'),
        readRows: async () => ({ accounts: [], transactions: [] }),
        insert: async () => job('1'),
        find: async () => undefined,
      },
      {
        read: async () => undefined,
        write: async () => true,
      },
      {
        createTerminalJob: async () => ({
          id: 'job-1',
          type: 'export_job',
          status: 'completed',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        createQueuedJob: async () => ({
          id: 'job-1',
          type: 'export_job',
          status: 'queued',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        transitionToProcessing: async () => ({
          id: 'job-1',
          type: 'export_job',
          status: 'processing',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        completeJob: async () => ({
          id: 'job-1',
          type: 'export_job',
          status: 'completed',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        failJob: async () => ({
          id: 'job-1',
          type: 'export_job',
          status: 'failed',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        deadLetter: async () => ({
          id: 'job-1',
          type: 'export_job',
          status: 'dead_letter',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        findJobById: async () => undefined,
      },
      () => fixedDate,
    );

    const outcome = await h.service.createExportJob(
      subject,
      workspace,
      command,
      'viewer-key',
    );
    expect(outcome.kind).toBe('forbidden');
  });

  it('handles concurrent collision replay when idempotency write races and succeeds in winning transaction', async () => {
    const existingJob = job('id-winner', 'queued');
    let reads = 0;
    const idempotencyStore: IdempotencyStore = {
      read: async () => {
        reads++;
        return reads === 1
          ? undefined
          : {
              requestFingerprint: computeRequestFingerprint(command),
              responseStatus: 202,
              responseEtag: null,
              responseBody: existingJob,
            };
      },
      write: async () => false,
    };

    let rolledBack = false;
    const tx = {
      run: async <T>(
        _s: string,
        cb: (client: { query: () => Promise<never> }) => Promise<T>,
      ) => {
        try {
          return await cb({
            query: async () => {
              throw new Error('not used');
            },
          });
        } catch (e) {
          rolledBack = true;
          throw e;
        }
      },
      runRead: async <T>(
        _s: string,
        cb: (client: { query: () => Promise<never> }) => Promise<T>,
      ) =>
        cb({
          query: async () => {
            throw new Error('not used');
          },
        }),
    };

    const store: ExportStore = {
      readActiveRole: async () => 'owner',
      createId: () => 'id-racer',
      reserve: async () => job('id-racer'),
      complete: async () => job('1'),
      fail: async () => job('1'),
      readRows: async () => ({ accounts: [], transactions: [] }),
      insert: async () => job('1'),
      find: async () => undefined,
    };

    const jobWriter: JobWriter = {
      createTerminalJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'completed',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      createQueuedJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'queued',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      transitionToProcessing: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'processing',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      completeJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'completed',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      failJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'failed',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      deadLetter: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'dead_letter',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      findJobById: async () => undefined,
    };

    const service = new ExportService(
      tx,
      store,
      idempotencyStore,
      jobWriter,
      () => fixedDate,
    );

    const outcome = await service.createExportJob(
      subject,
      workspace,
      command,
      'collision-key',
    );
    expect(outcome.kind).toBe('replayed');
    if (outcome.kind === 'replayed') {
      expect(outcome.status).toBe(202);
      expect(outcome.body).toEqual(existingJob);
    }
    expect(rolledBack).toBe(true);
  });

  it('handles concurrent collision conflict when idempotency write races with a different payload', async () => {
    let reads = 0;
    const idempotencyStore: IdempotencyStore = {
      read: async () => {
        reads++;
        return reads === 1
          ? undefined
          : {
              requestFingerprint: 'different-fingerprint-mismatch',
              responseStatus: 202,
              responseEtag: null,
              responseBody: job('id-other'),
            };
      },
      write: async () => false,
    };

    let rolledBack = false;
    const tx = {
      run: async <T>(
        _s: string,
        cb: (client: { query: () => Promise<never> }) => Promise<T>,
      ) => {
        try {
          return await cb({
            query: async () => {
              throw new Error('not used');
            },
          });
        } catch (e) {
          rolledBack = true;
          throw e;
        }
      },
      runRead: async <T>(
        _s: string,
        cb: (client: { query: () => Promise<never> }) => Promise<T>,
      ) =>
        cb({
          query: async () => {
            throw new Error('not used');
          },
        }),
    };

    const store: ExportStore = {
      readActiveRole: async () => 'owner',
      createId: () => 'id-racer',
      reserve: async () => job('id-racer'),
      complete: async () => job('1'),
      fail: async () => job('1'),
      readRows: async () => ({ accounts: [], transactions: [] }),
      insert: async () => job('1'),
      find: async () => undefined,
    };

    const jobWriter: JobWriter = {
      createTerminalJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'completed',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      createQueuedJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'queued',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      transitionToProcessing: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'processing',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      completeJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'completed',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      failJob: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'failed',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      deadLetter: async () => ({
        id: 'job-1',
        type: 'export_job',
        status: 'dead_letter',
        progressPercent: null,
        resultResourceId: null,
        error: null,
        createdAt: fixedDate.toISOString(),
        startedAt: null,
        completedAt: null,
      }),
      findJobById: async () => undefined,
    };

    const service = new ExportService(
      tx,
      store,
      idempotencyStore,
      jobWriter,
      () => fixedDate,
    );

    const outcome = await service.createExportJob(
      subject,
      workspace,
      command,
      'conflict-key',
    );
    expect(outcome.kind).toBe('idempotency-conflict');
    expect(rolledBack).toBe(true);
  });

  it('supports getExportJob for read roles, forbidden for unassigned roles, and not-found for missing jobs', async () => {
    const existing = job('found-id', 'completed');
    const store: ExportStore = {
      readActiveRole: async (_c, ws) =>
        ws === 'forbidden-ws' ? undefined : 'viewer',
      createId: () => '1',
      reserve: async () => job('1'),
      complete: async () => job('1'),
      fail: async () => job('1'),
      readRows: async () => ({ accounts: [], transactions: [] }),
      insert: async () => job('1'),
      find: async (_c, _ws, id) => (id === 'found-id' ? existing : undefined),
    };

    const tx = {
      run: async <T>(
        _s: string,
        cb: (client: { query: () => Promise<never> }) => Promise<T>,
      ) =>
        cb({
          query: async () => {
            throw new Error('not used');
          },
        }),
      runRead: async <T>(
        _s: string,
        cb: (client: { query: () => Promise<never> }) => Promise<T>,
      ) =>
        cb({
          query: async () => {
            throw new Error('not used');
          },
        }),
    };

    const service = new ExportService(
      tx,
      store,
      { read: async () => undefined, write: async () => true },
      {
        createTerminalJob: async () => ({
          id: '1',
          type: 'export_job',
          status: 'completed',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        createQueuedJob: async () => ({
          id: '1',
          type: 'export_job',
          status: 'queued',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        transitionToProcessing: async () => ({
          id: '1',
          type: 'export_job',
          status: 'processing',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        completeJob: async () => ({
          id: '1',
          type: 'export_job',
          status: 'completed',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        failJob: async () => ({
          id: '1',
          type: 'export_job',
          status: 'failed',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        deadLetter: async () => ({
          id: '1',
          type: 'export_job',
          status: 'dead_letter',
          progressPercent: null,
          resultResourceId: null,
          error: null,
          createdAt: fixedDate.toISOString(),
          startedAt: null,
          completedAt: null,
        }),
        findJobById: async () => undefined,
      },
      () => fixedDate,
    );

    const forbidden = await service.getExportJob(
      subject,
      'forbidden-ws',
      'found-id',
    );
    expect(forbidden).toEqual({ kind: 'forbidden' });

    const found = await service.getExportJob(subject, workspace, 'found-id');
    expect(found).toEqual({ kind: 'found', job: existing });

    const notFound = await service.getExportJob(
      subject,
      workspace,
      'missing-id',
    );
    expect(notFound).toEqual({ kind: 'not-found' });
  });
});
