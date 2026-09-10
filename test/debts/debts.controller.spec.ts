import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  DEBT_OUTCOMES,
  type Debt,
  type DebtsPort,
  type DebtTransaction,
} from '../../src/debts/debt.port.js';
import { DebtsController } from '../../src/debts/debts.controller.js';

describe('DebtsController', () => {
  const dummyDebt: Debt = {
    id: 'd0000000-0000-4000-8000-000000000001',
    name: 'Mortgage Loan',
    currency: 'USD',
    principal: { amountMinor: '25000000', currency: 'USD' },
    outstandingBalance: { amountMinor: '25000000', currency: 'USD' },
    annualRate: '0.045000000000000000',
    rateType: 'fixed',
    status: 'active',
  };

  const dummyTxn: DebtTransaction = {
    id: 't0000000-0000-4000-8000-000000000001',
    type: 'debt_payment',
    status: 'confirmed',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    amount: { amountMinor: '-5000', currency: 'USD' },
    occurredAt: '2026-09-03T12:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: null,
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

  function createMockPort(): DebtsPort {
    return {
      createDebt: vi.fn(async () => ({
        kind: DEBT_OUTCOMES.CREATED,
        debt: dummyDebt,
      })),
      listDebts: vi.fn(async () => ({
        kind: 'ok' as const,
        page: {
          items: [dummyDebt],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      })),
      createDebtPayment: vi.fn(async () => ({
        kind: DEBT_OUTCOMES.CREATED,
        transaction: dummyTxn,
      })),
    };
  }

  describe('create', () => {
    it('returns 400 if X-Workspace-Id is missing or invalid', async () => {
      const port = createMockPort();
      const controller = new DebtsController(port);
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
      const controller = new DebtsController(port);
      const req = {
        headers: { 'x-workspace-id': 'a0000000-0000-4000-8000-000000000001' },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('returns 422 if command validation fails', async () => {
      const port = createMockPort();
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: { name: '' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 201 on success', async () => {
      const port = createMockPort();
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: {
          name: 'Mortgage Loan',
          principal: { amountMinor: '25000000', currency: 'USD' },
          annualRate: '0.045',
          rateType: 'fixed',
        },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(dummyDebt);
    });

    it('returns 403 when forbidden', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebt).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.FORBIDDEN,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: {
          name: 'Mortgage Loan',
          principal: { amountMinor: '25000000', currency: 'USD' },
          annualRate: '0.045',
          rateType: 'fixed',
        },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(403);
    });

    it('replays response on idempotency replay', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebt).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.REPLAYED,
        status: 201,
        etag: null,
        body: dummyDebt,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: {
          name: 'Mortgage Loan',
          principal: { amountMinor: '25000000', currency: 'USD' },
          annualRate: '0.045',
          rateType: 'fixed',
        },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.create(req, reply);
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(dummyDebt);
    });
  });

  describe('list', () => {
    it('returns 200 with list outcome', async () => {
      const port = createMockPort();
      const controller = new DebtsController(port);
      const req = {
        headers: { 'x-workspace-id': 'a0000000-0000-4000-8000-000000000001' },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.list(req, reply);
      expect(reply.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 for invalid query', async () => {
      const port = createMockPort();
      const controller = new DebtsController(port);
      const req = {
        headers: { 'x-workspace-id': 'a0000000-0000-4000-8000-000000000001' },
        identity: { subject: 'sub1' },
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.list(req, reply, undefined, 'invalid-limit');
      expect(reply.status).toHaveBeenCalledWith(400);
    });
  });

  describe('createPayment', () => {
    const validPaymentBody = {
      accountId: 'a0000000-0000-4000-8000-000000000001',
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    };

    it('returns 201 on success', async () => {
      const port = createMockPort();
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: validPaymentBody,
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.createPayment(
        'd0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(dummyTxn);
    });

    it('returns 404 when debt is not found', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebtPayment).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.NOT_FOUND,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: validPaymentBody,
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.createPayment(
        'd0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(404);
    });

    it('returns 422 on debt currency mismatch', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebtPayment).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.CURRENCY_MISMATCH,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: validPaymentBody,
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.createPayment(
        'd0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 422 on account currency mismatch', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebtPayment).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: validPaymentBody,
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.createPayment(
        'd0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 422 on account not found', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebtPayment).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.ACCOUNT_NOT_FOUND,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: validPaymentBody,
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.createPayment(
        'd0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(422);
    });

    it('returns 422 on account closed', async () => {
      const port = createMockPort();
      vi.mocked(port.createDebtPayment).mockResolvedValueOnce({
        kind: DEBT_OUTCOMES.ACCOUNT_CLOSED,
      });
      const controller = new DebtsController(port);
      const req = {
        headers: {
          'x-workspace-id': 'a0000000-0000-4000-8000-000000000001',
          'idempotency-key': '00000000-0000-4000-8000-000000000001',
        },
        identity: { subject: 'sub1' },
        body: validPaymentBody,
      } as unknown as AuthenticatedRequest;
      const reply = createMockReply();

      await controller.createPayment(
        'd0000000-0000-4000-8000-000000000001',
        req,
        reply,
      );
      expect(reply.status).toHaveBeenCalledWith(422);
    });
  });
});
