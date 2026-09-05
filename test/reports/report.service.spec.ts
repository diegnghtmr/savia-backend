import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  REPORT_OUTCOMES,
  type CreateReportDefinitionRequest,
  type ReportDefinition,
  type ReportItem,
  type ReportStore,
} from '../../src/reports/report.port.js';
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
  }

  function createTxMock(): ReportTransaction & { state: TxMockState } {
    const fakeClient = {} as TransactionClient;
    const state: TxMockState = { committed: false, rolledBack: false };
    return {
      state,
      run: vi.fn().mockImplementation(async (_sub, cb) => {
        try {
          const result = await cb(fakeClient);
          state.committed = true;
          return result;
        } catch (error) {
          state.rolledBack = true;
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
});
