import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { ApprovalsController } from '../../src/approvals/approvals.controller.js';
import {
  APPROVAL_OUTCOMES,
  type ApprovalRequestPayload,
  type ApprovalsPort,
} from '../../src/approvals/approval.port.js';

describe('ApprovalsController', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const approvalId = 'bbbbbbbb-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';
  const validIdemKey = 'cccccccc-0000-4000-8000-000000000001';

  const sampleApprovalPayload: ApprovalRequestPayload = {
    id: approvalId,
    toolName: 'execute_sql',
    riskClass: 'destructive',
    argumentsHash: 'hash-abc',
    preview: { query: 'DROP TABLE test' },
    status: 'pending',
    expiresAt: '2026-09-06T12:00:00.000Z',
    createdAt: '2026-09-05T12:00:00.000Z',
  };

  function createMockReply() {
    const reply = {
      status: vi.fn().mockReturnThis(),
      code: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      request: {
        id: 'req-1',
        url: '/v1/approvals',
      },
    } as unknown as FastifyReply;
    return reply;
  }

  function createMockPort(): ApprovalsPort {
    return {
      getApproval: vi.fn().mockResolvedValue({
        kind: APPROVAL_OUTCOMES.OK,
        approval: sampleApprovalPayload,
      }),
      confirmApproval: vi.fn().mockResolvedValue({
        kind: APPROVAL_OUTCOMES.OK,
        approval: { ...sampleApprovalPayload, status: 'approved' },
      }),
      rejectApproval: vi.fn().mockResolvedValue({
        kind: APPROVAL_OUTCOMES.OK,
        approval: { ...sampleApprovalPayload, status: 'rejected' },
      }),
    };
  }

  describe('get', () => {
    it('returns 400 when X-Workspace-Id is missing or invalid', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.get(
        approvalId,
        {
          headers: {},
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when approvalId is not a valid UUID', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.get(
        'not-a-uuid',
        {
          headers: { 'x-workspace-id': workspaceId },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const port = createMockPort();
      vi.mocked(port.getApproval).mockResolvedValue({
        kind: APPROVAL_OUTCOMES.FORBIDDEN,
      });
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.get(
        approvalId,
        {
          headers: { 'x-workspace-id': workspaceId },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(403);
    });

    it('returns 404 when port returns NOT_FOUND', async () => {
      const port = createMockPort();
      vi.mocked(port.getApproval).mockResolvedValue({
        kind: APPROVAL_OUTCOMES.NOT_FOUND,
      });
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.get(
        approvalId,
        {
          headers: { 'x-workspace-id': workspaceId },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(404);
    });

    it('returns 200 with approval when found', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.get(
        approvalId,
        {
          headers: { 'x-workspace-id': workspaceId },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith(sampleApprovalPayload);
    });
  });

  describe('confirm', () => {
    it('returns 422 when body validation fails', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.confirm(
        approvalId,
        {
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': validIdemKey,
          },
          body: { extraField: true }, // missing argumentsHash, extra field
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 409 when port returns CONFLICT', async () => {
      const port = createMockPort();
      vi.mocked(port.confirmApproval).mockResolvedValue({
        kind: APPROVAL_OUTCOMES.CONFLICT,
        reason: 'Arguments hash mismatch',
      });
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.confirm(
        approvalId,
        {
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': validIdemKey,
          },
          body: { argumentsHash: 'hash-abc' },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(409);
    });

    it('replays response when port returns REPLAYED', async () => {
      const port = createMockPort();
      vi.mocked(port.confirmApproval).mockResolvedValue({
        kind: APPROVAL_OUTCOMES.REPLAYED,
        status: 200,
        etag: null,
        body: sampleApprovalPayload,
      });
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.confirm(
        approvalId,
        {
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': validIdemKey,
          },
          body: { argumentsHash: 'hash-abc' },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith(sampleApprovalPayload);
    });

    it('returns 200 when confirmation succeeds', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.confirm(
        approvalId,
        {
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': validIdemKey,
          },
          body: { argumentsHash: 'hash-abc' },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith({
        ...sampleApprovalPayload,
        status: 'approved',
      });
    });
  });

  describe('reject', () => {
    it('returns 422 when body validation fails on reject', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.reject(
        approvalId,
        {
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': validIdemKey,
          },
          body: { argumentsHash: 123 }, // invalid type
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 200 when rejection succeeds', async () => {
      const port = createMockPort();
      const controller = new ApprovalsController(port);
      const reply = createMockReply();

      await controller.reject(
        approvalId,
        {
          headers: {
            'x-workspace-id': workspaceId,
            'idempotency-key': validIdemKey,
          },
          body: { argumentsHash: 'hash-abc', reason: 'Rejected' },
          identity: { subject },
        } as unknown as AuthenticatedRequest,
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith({
        ...sampleApprovalPayload,
        status: 'rejected',
      });
    });
  });
});
