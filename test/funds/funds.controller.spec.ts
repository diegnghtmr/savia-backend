import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  FUND_OUTCOMES,
  type Fund,
  type FundsPort,
  type FundTransaction,
} from '../../src/funds/fund.port.js';
import { FundsController } from '../../src/funds/funds.controller.js';

describe('FundsController', () => {
  const dummyFund: Fund = {
    id: 'f0000000-0000-4000-8000-000000000001',
    name: 'Emergency Fund',
    currency: 'USD',
    targetAmount: { amountMinor: '100000', currency: 'USD' },
    currentAmount: { amountMinor: '0', currency: 'USD' },
    targetDate: '2026-12-31',
    linkedAccountId: null,
    status: 'active',
    version: 1,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
  };

  const dummyTxn: FundTransaction = {
    id: 't0000000-0000-4000-8000-000000000001',
    type: 'fund_contribution',
    status: 'confirmed',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    amount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-09-03T12:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: 'note',
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    version: 1,
  };

  function createMockReply() {
    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: { id: 'req-1', url: '/test' },
    } as unknown as FastifyReply;
    return reply;
  }

  function createMockPort(): FundsPort {
    return {
      createFund: vi.fn(async () => ({
        kind: FUND_OUTCOMES.CREATED,
        fund: dummyFund,
      })),
      listFunds: vi.fn(async () => ({
        kind: 'ok' as const,
        page: {
          items: [dummyFund],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      })),
      contributeToFund: vi.fn(async () => ({
        kind: FUND_OUTCOMES.CREATED,
        transaction: dummyTxn,
      })),
    };
  }

  describe('create', () => {
    it('returns 400 if X-Workspace-Id is missing or invalid', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: {},
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 if Idempotency-Key is missing or invalid', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: { 'x-workspace-id': 'a0000000-0000-4000-8000-000000000001' },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('returns 422 if body validation fails', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': 'b0000000-0000-4000-8000-000000000001',
        },
        body: { name: '' },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 201 with created fund on success', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': 'b0000000-0000-4000-8000-000000000001',
        },
        body: {
          name: 'Emergency Fund',
          currency: 'USD',
          targetAmount: { amountMinor: '100000', currency: 'USD' },
        },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(dummyFund);
    });
  });

  describe('list', () => {
    it('returns 400 if workspace header missing', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: {},
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.list(req, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('returns 200 with fund page on success', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: { 'x-workspace-id': 'a0000000-0000-4000-8000-000000000001' },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.list(req, reply);
      expect(reply.status).toHaveBeenCalledWith(200);
    });
  });

  describe('contribute', () => {
    it('returns 404 if fund not found', async () => {
      const port = createMockPort();
      vi.mocked(port.contributeToFund).mockResolvedValue({
        kind: FUND_OUTCOMES.NOT_FOUND,
      });
      const controller = new FundsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': 'b0000000-0000-4000-8000-000000000001',
        },
        body: {
          accountId: 'c0000000-0000-4000-8000-000000000001',
          amount: { amountMinor: '5000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.contribute(
        'f0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(404);
    });

    it('returns 201 with transaction on success', async () => {
      const port = createMockPort();
      const controller = new FundsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': 'b0000000-0000-4000-8000-000000000001',
        },
        body: {
          accountId: 'c0000000-0000-4000-8000-000000000001',
          amount: { amountMinor: '5000', currency: 'USD' },
          occurredAt: '2026-09-03T12:00:00Z',
        },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.contribute(
        'f0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(dummyTxn);
    });
  });
});
