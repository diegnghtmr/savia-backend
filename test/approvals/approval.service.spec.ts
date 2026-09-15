import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  APPROVAL_OUTCOMES,
  type ApprovalDecisionCommand,
  type ApprovalRecord,
  type ApprovalStore,
} from '../../src/approvals/approval.port.js';
import {
  ApprovalService,
  type ApprovalTransaction,
} from '../../src/approvals/approval.service.js';

describe('ApprovalService', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const approvalId = 'bbbbbbbb-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';
  const key = 'idem-key-1';
  const now = new Date('2026-09-05T12:00:00.000Z');
  const clock = () => now;

  const samplePendingRecord: ApprovalRecord = {
    id: approvalId,
    workspaceId,
    toolName: 'execute_sql',
    riskClass: 'destructive',
    argumentsHash: 'hash-abc-123',
    preview: { query: 'DROP TABLE test' },
    status: 'pending',
    expiresAt: new Date('2026-09-05T13:00:00.000Z'), // 1 hour in future
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdBy: subject,
    createdAt: new Date('2026-09-05T11:00:00.000Z'),
  };

  const command: ApprovalDecisionCommand = {
    argumentsHash: 'hash-abc-123',
    reason: 'Approved for migration',
  };

  interface TxMockState {
    committed: boolean;
    rolledBack: boolean;
    events: ('commit' | 'rollback')[];
  }

  function createTxMock(): ApprovalTransaction & { state: TxMockState } {
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

  function createStoreMock(): ApprovalStore {
    return {
      readActiveRole: vi.fn().mockResolvedValue('owner'),
      findApprovalById: vi.fn().mockResolvedValue(samplePendingRecord),
      updateApprovalDecision: vi
        .fn()
        .mockImplementation(
          async (
            _c,
            _w,
            _id,
            status,
            decidedBy,
            decidedAt,
            decisionReason,
          ) => ({
            ...samplePendingRecord,
            status,
            decidedBy,
            decidedAt,
            decisionReason,
          }),
        ),
    };
  }

  function createIdempotencyMock(): IdempotencyStore {
    return {
      read: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(true),
    };
  }

  describe('getApproval', () => {
    it('returns OK with approval payload for owner, admin, editor, viewer', async () => {
      for (const role of ['owner', 'administrator', 'editor', 'viewer']) {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.readActiveRole).mockResolvedValue(role);
        const idempotency = createIdempotencyMock();
        const service = new ApprovalService(tx, store, idempotency, clock);

        const outcome = await service.getApproval(
          subject,
          workspaceId,
          approvalId,
        );
        expect(outcome).toEqual({
          kind: APPROVAL_OUTCOMES.OK,
          approval: {
            id: approvalId,
            toolName: 'execute_sql',
            riskClass: 'destructive',
            argumentsHash: 'hash-abc-123',
            preview: { query: 'DROP TABLE test' },
            status: 'pending',
            expiresAt: samplePendingRecord.expiresAt.toISOString(),
            createdAt: samplePendingRecord.createdAt.toISOString(),
          },
        });
      }
    });

    it('returns FORBIDDEN when user has no active role or unrecognised role', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.readActiveRole).mockResolvedValue(undefined);
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.getApproval(
        subject,
        workspaceId,
        approvalId,
      );
      expect(outcome).toEqual({ kind: APPROVAL_OUTCOMES.FORBIDDEN });
    });

    it('returns NOT_FOUND when approval does not exist', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.findApprovalById).mockResolvedValue(undefined);
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.getApproval(
        subject,
        workspaceId,
        approvalId,
      );
      expect(outcome).toEqual({ kind: APPROVAL_OUTCOMES.NOT_FOUND });
    });

    it('reports status: expired when stored status is pending but expiresAt is in past', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.findApprovalById).mockResolvedValue({
        ...samplePendingRecord,
        status: 'pending',
        expiresAt: new Date('2026-09-05T11:59:59.000Z'), // 1s before now
      });
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.getApproval(
        subject,
        workspaceId,
        approvalId,
      );
      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.OK);
      if (outcome.kind === APPROVAL_OUTCOMES.OK) {
        expect(outcome.approval.status).toBe('expired');
      }
    });

    it('pins expiry boundary: reports status: expired when expiresAt is exactly equal to clock', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.findApprovalById).mockResolvedValue({
        ...samplePendingRecord,
        status: 'pending',
        expiresAt: new Date('2026-09-05T12:00:00.000Z'), // exactly now
      });
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.getApproval(
        subject,
        workspaceId,
        approvalId,
      );
      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.OK);
      if (outcome.kind === APPROVAL_OUTCOMES.OK) {
        expect(outcome.approval.status).toBe('expired');
      }
    });
  });

  describe('confirmApproval', () => {
    it('confirms pending approval when argumentsHash matches and user is owner or admin', async () => {
      for (const role of ['owner', 'administrator']) {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.readActiveRole).mockResolvedValue(role);
        const idempotency = createIdempotencyMock();
        const service = new ApprovalService(tx, store, idempotency, clock);

        const outcome = await service.confirmApproval(
          subject,
          workspaceId,
          approvalId,
          command,
          key,
        );

        expect(outcome.kind).toBe(APPROVAL_OUTCOMES.OK);
        if (outcome.kind === APPROVAL_OUTCOMES.OK) {
          expect(outcome.approval.status).toBe('approved');
          expect(outcome.approval.argumentsHash).toBe('hash-abc-123');
        }
        expect(store.updateApprovalDecision).toHaveBeenCalledWith(
          expect.anything(),
          workspaceId,
          approvalId,
          'approved',
          subject,
          now,
          'Approved for migration',
        );
        expect(tx.state.committed).toBe(true);
      }
    });

    it('returns FORBIDDEN when user is editor or viewer', async () => {
      for (const role of ['editor', 'viewer']) {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.readActiveRole).mockResolvedValue(role);
        const idempotency = createIdempotencyMock();
        const service = new ApprovalService(tx, store, idempotency, clock);

        const outcome = await service.confirmApproval(
          subject,
          workspaceId,
          approvalId,
          command,
          key,
        );

        expect(outcome).toEqual({ kind: APPROVAL_OUTCOMES.FORBIDDEN });
        expect(store.updateApprovalDecision).not.toHaveBeenCalled();
      }
    });

    it('returns CONFLICT when argumentsHash does not match stored hash', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        { argumentsHash: 'wrong-hash' },
        key,
      );

      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.CONFLICT);
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('returns CONFLICT when stored status is not pending (approved, rejected, expired, consumed)', async () => {
      for (const status of [
        'approved',
        'rejected',
        'expired',
        'consumed',
      ] as const) {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.findApprovalById).mockResolvedValue({
          ...samplePendingRecord,
          status,
        });
        const idempotency = createIdempotencyMock();
        const service = new ApprovalService(tx, store, idempotency, clock);

        const outcome = await service.confirmApproval(
          subject,
          workspaceId,
          approvalId,
          command,
          key,
        );

        expect(outcome.kind).toBe(APPROVAL_OUTCOMES.CONFLICT);
        expect(store.updateApprovalDecision).not.toHaveBeenCalled();
      }
    });

    it('returns CONFLICT when stored status is pending but expiresAt is in the past', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.findApprovalById).mockResolvedValue({
        ...samplePendingRecord,
        status: 'pending',
        expiresAt: new Date('2026-09-05T11:59:59.000Z'), // past relative to now (12:00:00)
      });
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.CONFLICT);
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('pins expiry boundary: returns CONFLICT when expiresAt is exactly equal to clock', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      vi.mocked(store.findApprovalById).mockResolvedValue({
        ...samplePendingRecord,
        status: 'pending',
        expiresAt: new Date('2026-09-05T12:00:00.000Z'), // exactly now
      });
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.CONFLICT);
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('replays response when idempotency record already exists with matching fingerprint', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const fingerprint = computeRequestFingerprint({
        approvalId,
        ...command,
      });

      const previousResponse = {
        id: approvalId,
        toolName: 'execute_sql',
        riskClass: 'destructive',
        argumentsHash: 'hash-abc-123',
        preview: { query: 'DROP TABLE test' },
        status: 'approved',
        expiresAt: samplePendingRecord.expiresAt.toISOString(),
      };

      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: fingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: previousResponse,
      });

      const service = new ApprovalService(tx, store, idempotency, clock);
      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome).toEqual({
        kind: APPROVAL_OUTCOMES.REPLAYED,
        status: 200,
        etag: null,
        body: previousResponse,
      });
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('returns CONFLICT when idempotency key is reused with different payload', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();

      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: 'different-fingerprint',
        responseStatus: 200,
        responseEtag: null,
        responseBody: {},
      });

      const service = new ApprovalService(tx, store, idempotency, clock);
      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome).toEqual({
        kind: APPROVAL_OUTCOMES.CONFLICT,
        reason:
          'Idempotency key already used with different request parameters',
      });
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('refuses idempotent replay with 409 Conflict when approval is already consumed', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const fingerprint = computeRequestFingerprint({
        approvalId,
        ...command,
      });

      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: fingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: { id: approvalId, status: 'approved' },
      });
      vi.mocked(store.findApprovalById).mockResolvedValue({
        ...samplePendingRecord,
        status: 'consumed',
      });

      const service = new ApprovalService(tx, store, idempotency, clock);
      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome).toEqual({
        kind: APPROVAL_OUTCOMES.CONFLICT,
        reason: 'Approval has already been consumed',
      });
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('refuses idempotent replay with 409 Conflict when approval has expired', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const fingerprint = computeRequestFingerprint({
        approvalId,
        ...command,
      });

      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: fingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: { id: approvalId, status: 'approved' },
      });
      vi.mocked(store.findApprovalById).mockResolvedValue({
        ...samplePendingRecord,
        status: 'approved',
        expiresAt: new Date('2026-09-05T11:00:00.000Z'), // expired relative to now (12:00:00)
      });

      const service = new ApprovalService(tx, store, idempotency, clock);
      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome).toEqual({
        kind: APPROVAL_OUTCOMES.CONFLICT,
        reason: 'Approval has expired',
      });
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });

    it('RULING 92: rolls back and handles concurrent collision replay via thrown ApprovalDecisionRollbackError', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const fingerprint = computeRequestFingerprint({
        approvalId,
        ...command,
      });

      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined) // first read sees nothing
        .mockResolvedValueOnce({
          // reread after failed write
          requestFingerprint: fingerprint,
          responseStatus: 200,
          responseEtag: null,
          responseBody: { id: approvalId, status: 'approved' },
        });
      vi.mocked(idempotency.write).mockResolvedValue(false); // write fails due to race

      const service = new ApprovalService(tx, store, idempotency, clock);
      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome).toEqual({
        kind: APPROVAL_OUTCOMES.REPLAYED,
        status: 200,
        etag: null,
        body: { id: approvalId, status: 'approved' },
      });
      expect(tx.state.rolledBack).toBe(true);
      expect(tx.state.committed).toBe(false);
    });

    it('RULING 92: rolls back and handles concurrent collision conflict via thrown ApprovalDecisionRollbackError', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();

      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          requestFingerprint: 'conflicting-fingerprint',
          responseStatus: 200,
          responseEtag: null,
          responseBody: {},
        });
      vi.mocked(idempotency.write).mockResolvedValue(false);

      const service = new ApprovalService(tx, store, idempotency, clock);
      const outcome = await service.confirmApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome).toEqual({ kind: APPROVAL_OUTCOMES.CONFLICT });
      expect(tx.state.rolledBack).toBe(true);
      expect(tx.state.committed).toBe(false);
    });
  });

  describe('rejectApproval', () => {
    it('rejects pending approval when argumentsHash matches and user is owner or admin', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.rejectApproval(
        subject,
        workspaceId,
        approvalId,
        command,
        key,
      );

      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.OK);
      if (outcome.kind === APPROVAL_OUTCOMES.OK) {
        expect(outcome.approval.status).toBe('rejected');
      }
      expect(store.updateApprovalDecision).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        approvalId,
        'rejected',
        subject,
        now,
        'Approved for migration',
      );
      expect(tx.state.committed).toBe(true);
    });

    it('returns FORBIDDEN for reject when user is editor or viewer', async () => {
      for (const role of ['editor', 'viewer']) {
        const tx = createTxMock();
        const store = createStoreMock();
        vi.mocked(store.readActiveRole).mockResolvedValue(role);
        const idempotency = createIdempotencyMock();
        const service = new ApprovalService(tx, store, idempotency, clock);

        const outcome = await service.rejectApproval(
          subject,
          workspaceId,
          approvalId,
          command,
          key,
        );

        expect(outcome).toEqual({ kind: APPROVAL_OUTCOMES.FORBIDDEN });
      }
    });

    it('returns CONFLICT for reject when argumentsHash mismatches', async () => {
      const tx = createTxMock();
      const store = createStoreMock();
      const idempotency = createIdempotencyMock();
      const service = new ApprovalService(tx, store, idempotency, clock);

      const outcome = await service.rejectApproval(
        subject,
        workspaceId,
        approvalId,
        { argumentsHash: 'wrong-hash' },
        key,
      );

      expect(outcome.kind).toBe(APPROVAL_OUTCOMES.CONFLICT);
      expect(store.updateApprovalDecision).not.toHaveBeenCalled();
    });
  });
});
