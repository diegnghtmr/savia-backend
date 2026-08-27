import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { TransactionController } from '../../src/ledger/transaction.controller.js';
import {
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  type LedgerPort,
  type Transaction,
} from '../../src/ledger/ledger.port.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

describe('TransactionController.createTransaction', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

  const mockTransaction: Transaction = {
    id: '00000000-0000-0000-0000-000000000t01',
    type: 'expense',
    status: 'confirmed',
    accountId: '00000000-0000-0000-0000-000000000a01',
    amount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-08-20T10:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: 'Groceries',
    notes: null,
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    version: 1,
  };

  const validBody = {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000000a01',
    amount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-08-20T10:00:00.000Z',
  };

  function createMocks(ledgerPortOverrides: Partial<LedgerPort> = {}) {
    const fakeLedgerPort: LedgerPort = {
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.CREATED,
        transaction: mockTransaction,
      }),
      read: vi.fn().mockResolvedValue({
        kind: TRANSACTION_READ_OUTCOMES.OK,
        transaction: mockTransaction,
      }),
      ...ledgerPortOverrides,
    };

    const controller = new TransactionController(fakeLedgerPort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: '/v1/transactions',
      },
    } as unknown as FastifyReply;

    return { controller, fakeLedgerPort, reply };
  }

  it('answers 400 when X-Workspace-Id header is missing or invalid', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'idempotency-key': idempotencyKey },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 400 when Idempotency-Key header is missing or invalid', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 422 UNPROCESSABLE when body fails schema validation', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: { invalid: 'payload' },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.UNPROCESSABLE }),
    );
  });

  it('answers 422 TRANSACTION_SPLITS_UNSUPPORTED when splits array is non-empty', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {
        ...validBody,
        splits: [
          {
            amount: { amountMinor: '5000', currency: 'USD' },
            categoryId: '00000000-0000-0000-0000-000000000002',
          },
        ],
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED,
      }),
    );
  });

  it('answers 403 FORBIDDEN when ledger port returns FORBIDDEN', async () => {
    const { controller, reply } = createMocks({
      create: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.FORBIDDEN }),
    );
  });

  it('answers 422 ACCOUNT_UNRESOLVED when account is not found in workspace', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.ACCOUNT_UNRESOLVED }),
    );
  });

  it('answers 422 ACCOUNT_CLOSED when account is closed', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.ACCOUNT_CLOSED }),
    );
  });

  it('answers 409 CONFLICT when idempotency conflict occurs', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.CONFLICT }),
    );
  });

  it('replays stored response on REPLAYED outcome', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.REPLAYED,
        status: 201,
        etag: '"1"',
        body: mockTransaction,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.header).toHaveBeenCalledWith('etag', '"1"');
    expect(reply.send).toHaveBeenCalledWith(mockTransaction);
  });

  it('returns 201 with ETag and created transaction body on success', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.header).toHaveBeenCalledWith('etag', '"1"');
    expect(reply.send).toHaveBeenCalledWith(mockTransaction);
  });
});

describe('TransactionController.getTransaction', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const transactionId = '00000000-0000-0000-0000-000000000t01';

  const mockTransaction: Transaction = {
    id: transactionId,
    type: 'expense',
    status: 'confirmed',
    accountId: '00000000-0000-0000-0000-000000000a01',
    amount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-08-20T10:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: 'Groceries',
    notes: null,
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    version: 1,
  };

  function createMocks(ledgerPortOverrides: Partial<LedgerPort> = {}) {
    const fakeLedgerPort: LedgerPort = {
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.CREATED,
        transaction: mockTransaction,
      }),
      read: vi.fn().mockResolvedValue({
        kind: TRANSACTION_READ_OUTCOMES.OK,
        transaction: mockTransaction,
      }),
      ...ledgerPortOverrides,
    };

    const controller = new TransactionController(fakeLedgerPort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: `/v1/transactions/${transactionId}`,
      },
    } as unknown as FastifyReply;

    return { controller, fakeLedgerPort, reply };
  }

  it('answers 400 when X-Workspace-Id header is missing or invalid', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {},
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 400 when transactionId is not a valid UUID', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getTransaction('invalid-uuid', request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 403 FORBIDDEN when ledger port returns FORBIDDEN', async () => {
    const { controller, reply } = createMocks({
      read: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_READ_OUTCOMES.FORBIDDEN }),
    });
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.FORBIDDEN }),
    );
  });

  it('answers 404 NOT_FOUND when ledger port returns NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      read: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_READ_OUTCOMES.NOT_FOUND }),
    });
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.NOT_FOUND }),
    );
  });

  it('returns 200 with ETag header and transaction body on success', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.getTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('etag', '"1"');
    expect(reply.send).toHaveBeenCalledWith(mockTransaction);
  });
});
