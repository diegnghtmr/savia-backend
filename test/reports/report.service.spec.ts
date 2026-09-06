import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  REPORT_OUTCOMES,
  REPORT_RUN_OUTCOMES,
  type CreateReportDefinitionRequest,
  type CreateReportRunRequest,
  type ReportDefinition,
  type ReportItem,
  type ReportRun,
  type ReportStore,
} from '../../src/reports/report.port.js';
import type { ArtifactStorage } from '../../src/platform/artifact-storage.port.js';
import {
  ReportService,
  type ReportTransaction,
} from '../../src/reports/report.service.js';

describe('ReportService', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';
  const key = 'idem-key-1';

  const command: CreateReportDefinitionRequest = {
    name: 'Sales Report',
    dimensions: ['month', 'category'],
    measures: ['sum'],
    visualization: 'bar',
    filters: {},
  };

  const sampleDefinition: ReportDefinition = {
    id: 'dddddddd-0000-4000-8000-000000000001',
    name: 'Sales Report',
    dimensions: ['month', 'category'],
    measures: ['sum'],
    visualization: 'bar',
    filters: {},
    version: 1,
  };

  interface TxMockState {
    committed: boolean;
    rolledBack: boolean;
    events: ('commit' | 'rollback')[];
  }

  function createTxMock(): ReportTransaction & { state: TxMockState } {
    const fakeClient = {} as TransactionClient;
    const state: TxMockState = {
      committed: false,
      rolledBack: false,
      events: [],
    };
    return {
      state,
      run: vi.fn().mockImplementation(async (_sub, cb) => {
        try {
          const result = await cb(fakeClient);
          state.committed = true;
          state.events.push('commit');
          return result;
        } catch (error) {
          state.rolledBack = true;
          state.events.push('rollback');
          throw error;
        }
      }),
      runRead: vi.fn().mockImplementation(async (_sub, cb) => cb(fakeClient)),
    };
  }

  function createStoreMock(): ReportStore {
    return {
      readActiveRole: vi.fn().mockResolvedValue('owner'),
      createReportDefinition: vi.fn().mockResolvedValue(sampleDefinition),
      listReportDefinitions: vi.fn().mockResolvedValue([]),
    };
  }

  function createIdempotencyMock(): IdempotencyStore {
    return {
      read: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(true),
    };
  }

  const runCommand: CreateReportRunRequest = {
    preset: 'expenses',
    format: 'json',
    filters: {},
  };

  const sampleRun: ReportRun = {
    id: 'eeeeeeee-0000-4000-8000-000000000001',
    definitionId: null,
    preset: 'expenses',
    status: 'completed',
    format: 'json',
    snapshotId: 'ffffffff-0000-4000-8000-000000000001',
    downloadUrl: 'https://storage.example.test/report.json',
    expiresAt: '2026-09-12T00:00:00.000Z',
    createdAt: '2026-09-05T00:00:00.000Z',
  };

  function createRunStore(): ReportStore {
    return {
      ...createStoreMock(),
      readReportDefinition: vi.fn().mockResolvedValue(undefined),
      readWorkspaceBaseCurrency: vi.fn().mockResolvedValue('USD'),
      readReportSourceRows: vi.fn().mockResolvedValue([]),
      readBudgetedMinorByBucket: vi.fn().mockResolvedValue(new Map()),
      insertReportRun: vi.fn().mockResolvedValue(sampleRun),
      findReportRun: vi.fn().mockResolvedValue(sampleRun),
    };
  }

  function createStorageMock(): ArtifactStorage & {
    remove: ReturnType<typeof vi.fn>;
  } {
    return {
      upload: vi.fn().mockResolvedValue(undefined),
      sign: vi.fn().mockResolvedValue({
        url: sampleRun.downloadUrl,
        expiresAt: new Date('2026-09-12T00:00:00.000Z'),
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
  }

  describe('createReportDefinition', () => {
    it('returns FORBIDDEN when user role is viewer or undefined', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.readActiveRole).mockResolvedValue('viewer');
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      const outcome = await service.createReportDefinition(
        subject,
        workspaceId,
        command,
        key,
      );
      expect(outcome).toEqual({ kind: REPORT_OUTCOMES.FORBIDDEN });
    });

    it.each(['owner', 'administrator', 'editor'] as const)(
      'allows %s role to create report definition',
      async (role) => {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.readActiveRole).mockResolvedValue(role);
        const idempotency = createIdempotencyMock();
        const service = new ReportService(tx, store, idempotency);

        const outcome = await service.createReportDefinition(
          subject,
          workspaceId,
          command,
          key,
        );
        expect(outcome.kind).toBe(REPORT_OUTCOMES.CREATED);
      },
    );

    it('returns CREATED on first request and writes idempotency record', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      const outcome = await service.createReportDefinition(
        subject,
        workspaceId,
        command,
        key,
      );
      expect(outcome).toEqual({
        kind: REPORT_OUTCOMES.CREATED,
        reportDefinition: sampleDefinition,
      });
      expect(store.createReportDefinition).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        subject,
        command,
      );
      expect(idempotency.write).toHaveBeenCalledWith(
        expect.anything(),
        subject,
        'POST /v1/report-definitions',
        key,
        expect.any(String),
        201,
        null,
        sampleDefinition,
        workspaceId,
      );
    });

    it('returns REPLAYED when existing idempotency record matches fingerprint', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      // First run to get fingerprint
      await service.createReportDefinition(subject, workspaceId, command, key);
      const fingerprint = vi.mocked(idempotency.write).mock.calls[0][4];

      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: fingerprint,
        responseStatus: 201,
        responseEtag: null,
        responseBody: sampleDefinition,
      });

      const outcome = await service.createReportDefinition(
        subject,
        workspaceId,
        command,
        key,
      );
      expect(outcome).toEqual({
        kind: REPORT_OUTCOMES.REPLAYED,
        status: 201,
        etag: null,
        body: sampleDefinition,
      });
      expect(store.createReportDefinition).toHaveBeenCalledTimes(1); // not called again
    });

    it('returns CONFLICT when existing idempotency record has different fingerprint', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: 'different-fingerprint',
        responseStatus: 201,
        responseEtag: null,
        responseBody: sampleDefinition,
      });
      const service = new ReportService(tx, store, idempotency);

      const outcome = await service.createReportDefinition(
        subject,
        workspaceId,
        command,
        key,
      );
      expect(outcome).toEqual({ kind: REPORT_OUTCOMES.CONFLICT });
    });

    it('rolls back and handles concurrent collision replay via thrown ReportDefinitionCreateRollbackError', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const fingerprint = computeRequestFingerprint(command);

      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined) // first read sees nothing
        .mockResolvedValueOnce({
          // reread after failed write sees winner
          requestFingerprint: fingerprint,
          responseStatus: 201,
          responseEtag: null,
          responseBody: sampleDefinition,
        });
      vi.mocked(idempotency.write).mockResolvedValue(false); // write fails due to race

      const service = new ReportService(tx, store, idempotency);
      const outcome = await service.createReportDefinition(
        subject,
        workspaceId,
        command,
        key,
      );
      expect(outcome).toEqual({
        kind: REPORT_OUTCOMES.REPLAYED,
        status: 201,
        etag: null,
        body: sampleDefinition,
      });
      expect(tx.state.rolledBack).toBe(true);
      expect(tx.state.committed).toBe(false);
    });

    it('rolls back and handles concurrent collision conflict via thrown ReportDefinitionCreateRollbackError', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          requestFingerprint: 'conflicting-fingerprint',
          responseStatus: 201,
          responseEtag: null,
          responseBody: sampleDefinition,
        });
      vi.mocked(idempotency.write).mockResolvedValue(false);

      const outcome = await service.createReportDefinition(
        subject,
        workspaceId,
        command,
        key,
      );
      expect(outcome).toEqual({ kind: REPORT_OUTCOMES.CONFLICT });
      expect(tx.state.rolledBack).toBe(true);
      expect(tx.state.committed).toBe(false);
    });
  });

  describe('listReportDefinitions', () => {
    it('returns FORBIDDEN when user has no active role in workspace', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.readActiveRole).mockResolvedValue(undefined);
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      const outcome = await service.listReportDefinitions(subject, {
        workspaceId,
        limit: 10,
      });
      expect(outcome).toEqual({ kind: REPORT_OUTCOMES.FORBIDDEN });
    });

    it.each(['owner', 'administrator', 'editor', 'viewer'] as const)(
      'allows %s role to list report definitions',
      async (role) => {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.readActiveRole).mockResolvedValue(role);
        const idempotency = createIdempotencyMock();
        const service = new ReportService(tx, store, idempotency);

        const outcome = await service.listReportDefinitions(subject, {
          workspaceId,
          limit: 10,
        });
        expect(outcome.kind).toBe('ok');
      },
    );

    it('returns page without nextCursor when results do not exceed limit', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const items: ReportItem[] = [
        {
          reportDefinition: sampleDefinition,
          cursorAt: '2026-09-05T00:00:00.000000Z',
        },
      ];
      vi.mocked(store.listReportDefinitions).mockResolvedValue(items);
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      const outcome = await service.listReportDefinitions(subject, {
        workspaceId,
        limit: 10,
      });
      expect(outcome).toEqual({
        kind: 'ok',
        page: {
          items: [sampleDefinition],
          pageInfo: {
            hasNextPage: false,
            nextCursor: null,
          },
        },
      });
    });

    it('returns page with nextCursor when results exceed limit', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const item1: ReportItem = {
        reportDefinition: {
          ...sampleDefinition,
          id: '11111111-0000-4000-8000-000000000001',
        },
        cursorAt: '2026-09-05T01:00:00.000000Z',
      };
      const item2: ReportItem = {
        reportDefinition: {
          ...sampleDefinition,
          id: '22222222-0000-4000-8000-000000000002',
        },
        cursorAt: '2026-09-05T02:00:00.000000Z',
      };
      // limit is 1, store returns 2 items
      vi.mocked(store.listReportDefinitions).mockResolvedValue([item1, item2]);
      const idempotency = createIdempotencyMock();
      const service = new ReportService(tx, store, idempotency);

      const outcome = await service.listReportDefinitions(subject, {
        workspaceId,
        limit: 1,
      });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind === 'ok') {
        expect(outcome.page.items).toHaveLength(1);
        expect(outcome.page.items[0]).toEqual(item1.reportDefinition);
        expect(outcome.page.pageInfo.hasNextPage).toBe(true);
        expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
      }
    });
  });

  describe('createReportRun', () => {
    it('passes the preset type filter and prevents a caller from widening it', async () => {
      const tx = createTxMock();
      const store = createRunStore();
      const service = new ReportService(
        tx,
        store,
        createIdempotencyMock(),
        createStorageMock(),
      );

      const outcome = await service.createReportRun(
        subject,
        workspaceId,
        {
          ...runCommand,
          filters: { type: 'income' },
        },
        key,
      );

      expect(outcome.kind).toBe(REPORT_RUN_OUTCOMES.CREATED);
      expect(store.readReportSourceRows).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        expect.any(String),
        expect.any(String),
        'expense',
        'income',
      );
    });

    it('intersects definition filters (type, from, to) with caller filters and prevents caller from widening them', async () => {
      const tx = createTxMock();
      const store = createRunStore();
      const savedDefinition: ReportDefinition = {
        id: 'dddddddd-0000-4000-8000-000000000001',
        name: 'Expense Q2',
        dimensions: ['category'],
        measures: ['converted_value'],
        visualization: 'table',
        filters: {
          type: 'expense',
          from: '2026-04-01',
          to: '2026-06-30',
        },
        version: 1,
      };
      vi.mocked(store.readReportDefinition!).mockResolvedValue(savedDefinition);
      const service = new ReportService(
        tx,
        store,
        createIdempotencyMock(),
        createStorageMock(),
      );

      const outcome = await service.createReportRun(
        subject,
        workspaceId,
        {
          definitionId: savedDefinition.id,
          format: 'json',
          filters: {
            from: '2026-01-01',
            to: '2026-12-31',
            type: 'income',
          },
        },
        key,
      );

      expect(outcome.kind).toBe(REPORT_RUN_OUTCOMES.CREATED);
      expect(store.readReportSourceRows).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        '2026-04-01',
        '2026-06-30',
        'expense',
        'income',
      );
    });

    it('returns UNPROCESSABLE for an unknown definition without reading source rows', async () => {
      const tx = createTxMock();
      const store = createRunStore();
      const service = new ReportService(
        tx,
        store,
        createIdempotencyMock(),
        createStorageMock(),
      );

      const outcome = await service.createReportRun(
        subject,
        workspaceId,
        {
          definitionId: 'dddddddd-0000-4000-8000-000000000099',
          format: 'json',
          filters: {},
        },
        key,
      );

      expect(outcome).toEqual({
        kind: REPORT_RUN_OUTCOMES.UNPROCESSABLE,
        violations: [
          {
            field: 'definitionId',
            message: 'Report definition was not found.',
          },
        ],
      });
      expect(store.readReportSourceRows).not.toHaveBeenCalled();
    });

    it('rolls back the insert transaction for a concurrent replay and cleans up storage', async () => {
      const tx = createTxMock();
      const store = createRunStore();
      const idempotency = createIdempotencyMock();
      const storage = createStorageMock();
      const fingerprint = computeRequestFingerprint(runCommand);
      vi.mocked(idempotency.write).mockResolvedValue(false);
      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          requestFingerprint: fingerprint,
          responseStatus: 202,
          responseEtag: null,
          responseBody: sampleRun,
        });

      const service = new ReportService(tx, store, idempotency, storage);
      const outcome = await service.createReportRun(
        subject,
        workspaceId,
        runCommand,
        key,
      );

      expect(outcome).toEqual({
        kind: REPORT_RUN_OUTCOMES.REPLAYED,
        status: 202,
        etag: null,
        body: sampleRun,
      });
      expect(tx.state.events).toEqual(['commit', 'rollback']);
      expect(storage.remove).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${workspaceId}/`)),
      );
    });

    it('returns replay outcome even when storage cleanup fails', async () => {
      const tx = createTxMock();
      const store = createRunStore();
      const idempotency = createIdempotencyMock();
      const storage = createStorageMock();
      vi.mocked(storage.remove).mockRejectedValue(new Error('cleanup failed'));
      const fingerprint = computeRequestFingerprint(runCommand);
      vi.mocked(idempotency.write).mockResolvedValue(false);
      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          requestFingerprint: fingerprint,
          responseStatus: 202,
          responseEtag: null,
          responseBody: sampleRun,
        });

      const service = new ReportService(tx, store, idempotency, storage);
      const outcome = await service.createReportRun(
        subject,
        workspaceId,
        runCommand,
        key,
      );

      expect(outcome).toEqual({
        kind: REPORT_RUN_OUTCOMES.REPLAYED,
        status: 202,
        etag: null,
        body: sampleRun,
      });
      expect(tx.state.events).toEqual(['commit', 'rollback']);
      expect(storage.remove).toHaveBeenCalled();
    });

    it('rolls back the insert transaction for a concurrent conflict', async () => {
      const tx = createTxMock();
      const store = createRunStore();
      const idempotency = createIdempotencyMock();
      const storage = createStorageMock();
      vi.mocked(idempotency.write).mockResolvedValue(false);
      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          requestFingerprint: 'different-fingerprint',
          responseStatus: 202,
          responseEtag: null,
          responseBody: sampleRun,
        });

      const service = new ReportService(tx, store, idempotency, storage);
      await expect(
        service.createReportRun(subject, workspaceId, runCommand, key),
      ).resolves.toEqual({ kind: REPORT_RUN_OUTCOMES.CONFLICT });
      expect(tx.state.events).toEqual(['commit', 'rollback']);
    });
  });
});
