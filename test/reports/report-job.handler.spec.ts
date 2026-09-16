import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  ReportJobHandler,
  ReportWriteForbiddenError,
} from '../../src/reports/report-job.handler.js';
import type { ReportJobPayload } from '../../src/reports/report-job-payload.js';
import { PostgresReportAdapter } from '../../src/reports/postgres-report.adapter.js';
import type { ReportGrid } from '../../src/reports/report-engine.js';

const payload: ReportJobPayload = {
  version: 1,
  asOf: '2026-09-15T12:00:00.000Z',
  reportRunId: 'eeeeeeee-0000-4000-8000-000000000001',
  format: 'json',
  definitionId: null,
  preset: 'expenses',
  filters: { from: '2026-06-01', to: '2026-06-30' },
  periodStart: '2026-06-01',
  periodTo: '2026-06-30',
  shapeTypeFilter: 'expense',
  callerType: null,
  dimensions: ['category'],
  measures: ['converted_value', 'percentage'],
  objectKey:
    'aaaaaaaa-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000001.json',
  baseCurrency: 'USD',
};

const context = {
  jobId: 'aaaaaaaa-0000-4000-8000-000000000099',
  workspaceId: 'aaaaaaaa-0000-4000-8000-000000000001',
  actorId: '11111111-0000-4000-8000-000000000001',
  attemptCount: 1,
  payload,
};

const emptyGrid: ReportGrid = {
  dimensions: ['category'],
  measures: ['converted_value', 'percentage'],
  rows: [],
  warnings: [],
  baseCurrency: 'USD',
};

function createStorage(): ArtifactStorage & {
  uploaded: string[];
} {
  const uploaded: string[] = [];
  return {
    uploaded,
    upload: vi.fn(async (path: string) => {
      uploaded.push(path);
    }),
    sign: vi.fn(async (path: string, expiresAt: Date) => ({
      url: `https://storage.example.test/${path}`,
      expiresAt,
    })),
    remove: vi.fn(),
  };
}

function createStore(role = 'editor') {
  const processing: string[] = [];
  const completed: string[] = [];
  return {
    role,
    processing,
    completed,
    readActiveRole: async () => role,
    readReportSourceRows: async () => [],
    readBudgetedMinorByBucket: async () => new Map(),
    beginProcessingReportRun: async (
      _client: TransactionClient,
      _workspaceId: string,
      reportRunId: string,
    ) => {
      processing.push(reportRunId);
    },
    completeProcessingReportRun: async (
      _client: TransactionClient,
      _workspaceId: string,
      reportRunId: string,
    ) => {
      completed.push(reportRunId);
    },
  };
}

describe('ReportJobHandler', () => {
  it('rejects an invalid frozen payload', () => {
    const handler = new ReportJobHandler(
      createStore() as unknown as PostgresReportAdapter,
      createStorage(),
    );
    expect(() => handler.parsePayload({ nope: true })).toThrow(
      /unknown or missing fields/,
    );
  });

  it('rejects a payload whose object key carries a foreign workspace prefix', () => {
    const handler = new ReportJobHandler(
      createStore() as unknown as PostgresReportAdapter,
      createStorage(),
    );
    expect(() =>
      handler.parsePayload(payload, {
        workspaceId: 'bbbbbbbb-0000-4000-8000-000000000001',
      }),
    ).toThrow(/objectKey must match the job workspace/);
  });

  it('uploads to the reserved object key rather than a per-attempt key', async () => {
    const storage = createStorage();
    const handler = new ReportJobHandler(
      createStore() as unknown as PostgresReportAdapter,
      storage,
      () => new Date('2026-09-15T12:00:00.000Z'),
    );
    await handler.materialize(context, emptyGrid, 5_000);
    expect(storage.uploaded).toEqual([payload.objectKey]);
    await handler.materialize(
      { ...context, attemptCount: 2 },
      emptyGrid,
      5_000,
    );
    expect(storage.uploaded).toEqual([payload.objectKey, payload.objectKey]);
  });

  it('refuses persist when the actor no longer has a write role', async () => {
    const store = createStore('viewer');
    const handler = new ReportJobHandler(
      store as unknown as PostgresReportAdapter,
      createStorage(),
    );
    await expect(
      handler.persist(
        context,
        {
          downloadUrl: 'https://storage.example.test/report.json',
          expiresAt: new Date('2026-09-22T12:00:00.000Z'),
          completedAt: new Date('2026-09-15T12:00:00.000Z'),
        },
        {} as TransactionClient,
      ),
    ).rejects.toBeInstanceOf(ReportWriteForbiddenError);
    expect(store.processing).toHaveLength(0);
    expect(store.completed).toHaveLength(0);
  });

  it('marks the run processing then completed after re-checking the write role', async () => {
    const store = createStore('editor');
    const handler = new ReportJobHandler(
      store as unknown as PostgresReportAdapter,
      createStorage(),
    );
    const id = await handler.persist(
      context,
      {
        downloadUrl: 'https://storage.example.test/report.json',
        expiresAt: new Date('2026-09-22T12:00:00.000Z'),
        completedAt: new Date('2026-09-15T12:00:00.000Z'),
      },
      {} as TransactionClient,
    );
    expect(id).toBe(payload.reportRunId);
    expect(store.processing).toEqual([payload.reportRunId]);
    expect(store.completed).toEqual([payload.reportRunId]);
  });
});
