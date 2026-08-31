import { describe, expect, it } from 'vitest';
import { ExportService } from '../../src/exports/export.service.js';
import {
  type ExportJob,
  type ExportStore,
  type ExportStorage,
} from '../../src/exports/export.port.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';

const subject = '00000000-0000-0000-0000-000000000001';
const workspace = '00000000-0000-0000-0000-000000000002';
const command = {
  format: 'csv' as const,
  resource: 'all' as const,
  resourceId: null,
  from: null,
  to: null,
};
const job = (
  id: string,
  status: ExportJob['status'] = 'completed',
): ExportJob => ({
  id,
  status,
  format: 'csv',
  downloadUrl: status === 'completed' ? 'https://signed.test/file' : null,
  expiresAt: status === 'completed' ? '2026-09-07T00:00:00.000Z' : null,
  createdAt: '2026-08-31T00:00:00.000Z',
});

function harness(
  sign: ExportStorage['sign'] = async (_path, expiry) => ({
    url: 'https://signed.test/file',
    expiresAt: expiry,
  }),
) {
  const records = new Map<string, IdempotencyRecord>();
  let jobs = 0;
  let uploads = 0;
  const store: ExportStore = {
    readActiveRole: async () => 'owner',
    createId: () => `00000000-0000-0000-0000-00000000000${jobs + 3}`,
    readRows: async () => ({ accounts: [{ id: 'a' }], transactions: [] }),
    insert: async (
      _client,
      _ws,
      _subject,
      id,
      _command,
      _path,
      url,
      expiry,
      error,
    ) => {
      jobs += 1;
      return job(id, error ? 'failed' : 'completed');
    },
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
  const storage: ExportStorage = {
    upload: async () => {
      uploads += 1;
    },
    sign,
    remove: async () => undefined,
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
    service: new ExportService(transaction, store, idempotency, storage),
    counts: () => ({ jobs, uploads }),
  };
}

describe('ExportService', () => {
  it('replays idempotent requests without a second job or object', async () => {
    const h = harness();
    const first = await h.service.createExportJob(
      subject,
      workspace,
      command,
      'key',
    );
    const second = await h.service.createExportJob(
      subject,
      workspace,
      command,
      'key',
    );
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('replayed');
    expect(h.counts()).toEqual({ jobs: 1, uploads: 1 });
  });
  it('persists a terminal failed job outside the failed generation transaction', async () => {
    const h = harness(async () => {
      throw new Error('serializer signing failed');
    });
    const outcome = await h.service.createExportJob(
      subject,
      workspace,
      command,
      'failure-key',
    );
    expect(outcome.kind).toBe('failed');
    expect(h.counts().jobs).toBe(1);
    expect(h.counts().uploads).toBe(1);
  });
});
