import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { TransactionController } from '../../src/ledger/transaction.controller.js';
import {
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_LIST_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  TRANSACTION_UPDATE_OUTCOMES,
  TRANSACTION_VOID_OUTCOMES,
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
      list: vi.fn().mockResolvedValue({
        kind: TRANSACTION_LIST_OUTCOMES.OK,
        page: {
          items: [mockTransaction],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.OK,
        transaction: mockTransaction,
      }),
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.OK,
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

  it('answers 422 with Category not found problem when outcome is CATEGORY_NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.CATEGORY_NOT_FOUND,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {
        ...validBody,
        categoryId: '00000000-0000-0000-0000-000000000c01',
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.type).toHaveBeenCalledWith('application/problem+json');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Category not found',
        detail: 'The specified category was not found in this workspace.',
        status: 422,
        code: 'unprocessable',
      }),
    );
  });

  it('answers 422 with Payee not found problem when outcome is PAYEE_NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.PAYEE_NOT_FOUND,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {
        ...validBody,
        payeeId: '00000000-0000-0000-0000-000000000002',
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.type).toHaveBeenCalledWith('application/problem+json');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Payee not found',
        detail: 'The specified payee was not found in this workspace.',
        status: 422,
        code: 'unprocessable',
      }),
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
  const transactionId = '00000000-0000-0000-0000-000000007001';

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
      list: vi.fn().mockResolvedValue({
        kind: TRANSACTION_LIST_OUTCOMES.OK,
        page: {
          items: [mockTransaction],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.OK,
        transaction: mockTransaction,
      }),
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.OK,
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

describe('TransactionController.listTransactions', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';

  function createMocks(ledgerPortOverrides: Partial<LedgerPort> = {}) {
    const fakeLedgerPort: LedgerPort = {
      create: vi.fn(),
      read: vi.fn(),
      list: vi.fn().mockResolvedValue({
        kind: TRANSACTION_LIST_OUTCOMES.OK,
        page: {
          items: [],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      update: vi.fn(),
      void: vi.fn(),
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
      headers: {},
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.listTransactions(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 400 when query validation fails', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.listTransactions(
      request,
      reply,
      undefined,
      'invalid-limit',
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 403 when ledger port returns FORBIDDEN', async () => {
    const { controller, reply } = createMocks({
      list: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_LIST_OUTCOMES.FORBIDDEN }),
    });
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.listTransactions(request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.FORBIDDEN }),
    );
  });

  it('answers 200 with page payload on success and passes parsed query to ledger.list', async () => {
    const page = {
      items: [],
      pageInfo: { hasNextPage: false, nextCursor: null },
    };
    const { controller, fakeLedgerPort, reply } = createMocks({
      list: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_LIST_OUTCOMES.OK, page }),
    });
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.listTransactions(
      request,
      reply,
      undefined,
      '20',
      '00000000-0000-0000-0000-000000000a01',
      '2026-08-01',
      '2026-08-31',
      '00000000-0000-0000-0000-000000000c01',
      'confirmed',
      'Groceries',
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(page);
    expect(fakeLedgerPort.list).toHaveBeenCalledWith(subject, {
      workspaceId,
      limit: 20,
      accountId: '00000000-0000-0000-0000-000000000a01',
      from: '2026-08-01',
      to: '2026-08-31',
      categoryId: '00000000-0000-0000-0000-000000000c01',
      status: 'confirmed',
      query: 'Groceries',
    });
  });
});

describe('TransactionController.updateTransaction', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const transactionId = '00000000-0000-0000-0000-000000007001';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

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
    version: 2,
  };

  const validBody = {
    description: 'Updated Groceries',
    status: 'pending',
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
      list: vi.fn().mockResolvedValue({
        kind: TRANSACTION_LIST_OUTCOMES.OK,
        page: {
          items: [mockTransaction],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.OK,
        transaction: mockTransaction,
      }),
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.OK,
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
      headers: { 'idempotency-key': idempotencyKey },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 400 when transactionId path parameter is not a UUID', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction('not-a-uuid', request, reply);

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

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 412 when If-Match header is malformed', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        'if-match': 'malformed-etag',
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(412);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.PRECONDITION_FAILED }),
    );
  });

  it('answers 422 when body is empty object (empty-update, minProperties: 1)', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {},
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.UNPROCESSABLE }),
    );
  });

  it('answers 422 when body contains unknown or immutable fields (additionalProperties: false)', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: { ...validBody, amount: { amountMinor: '5000', currency: 'USD' } },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

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

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED,
      }),
    );
  });

  it('asserts literal equality of problem-type string between createTransaction and updateTransaction splits refusal', async () => {
    const { controller } = createMocks();
    const splitsBody = {
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000a01',
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      splits: [
        {
          amount: { amountMinor: '5000', currency: 'USD' },
          categoryId: '00000000-0000-0000-0000-000000000002',
        },
      ],
    };

    let postProblem: { type?: string } = {};
    let patchProblem: { type?: string } = {};

    const postReply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockImplementation((payload) => {
        postProblem = payload;
        return postReply;
      }),
      header: vi.fn().mockReturnThis(),
      request: { id: 'trace-post', url: '/v1/transactions' },
    } as unknown as FastifyReply;

    const patchReply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockImplementation((payload) => {
        patchProblem = payload;
        return patchReply;
      }),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-patch',
        url: `/v1/transactions/${transactionId}`,
      },
    } as unknown as FastifyReply;

    const reqPost = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: splitsBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    const reqPatch = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: { description: 'Update', splits: splitsBody.splits },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransaction(reqPost, postReply);
    await controller.updateTransaction(transactionId, reqPatch, patchReply);

    expect(postProblem.type).toBe(PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED);
    expect(patchProblem.type).toBe(
      PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED,
    );
    expect(patchProblem.type).toBe(postProblem.type);
  });

  it('answers 403 FORBIDDEN when ledger port returns FORBIDDEN', async () => {
    const { controller, reply } = createMocks({
      update: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.FORBIDDEN }),
    );
  });

  it('answers 409 TRANSACTION_VOIDED with title "Transaction is voided" when ledger port returns VOIDED', async () => {
    const { controller, reply } = createMocks({
      update: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_UPDATE_OUTCOMES.VOIDED }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_VOIDED,
        title: 'Transaction is voided',
      }),
    );
  });

  it('answers 409 TRANSACTION_RECONCILED when ledger port returns RECONCILED (Épica 5 stub)', async () => {
    const { controller, reply } = createMocks({
      update: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_UPDATE_OUTCOMES.RECONCILED }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_RECONCILED,
        title: 'Transaction is reconciled',
      }),
    );
  });

  it('answers 409 CONFLICT when idempotency conflict occurs', async () => {
    const { controller, reply } = createMocks({
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
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

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.CONFLICT }),
    );
  });

  it('answers 404 NOT_FOUND when ledger port returns NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      update: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.NOT_FOUND }),
    );
  });

  it('answers 412 PRECONDITION_FAILED when ledger port returns VERSION_CONFLICT', async () => {
    const { controller, reply } = createMocks({
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        'if-match': '"1"',
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(412);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.PRECONDITION_FAILED }),
    );
  });

  it('replays stored response on REPLAYED outcome', async () => {
    const { controller, reply } = createMocks({
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.REPLAYED,
        status: 200,
        etag: '"2"',
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

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('etag', '"2"');
    expect(reply.send).toHaveBeenCalledWith(mockTransaction);
  });

  it('returns 200 with ETag header and updated transaction body on success', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        'if-match': '"1"',
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('etag', '"2"');
    expect(reply.send).toHaveBeenCalledWith(mockTransaction);
  });

  it('answers 422 with Category not found problem when update outcome is CATEGORY_NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.CATEGORY_NOT_FOUND,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      params: { transactionId: mockTransaction.id },
      body: {
        categoryId: '00000000-0000-0000-0000-000000000c02',
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(mockTransaction.id, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.type).toHaveBeenCalledWith('application/problem+json');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Category not found',
        detail: 'The specified category was not found in this workspace.',
        status: 422,
        code: 'unprocessable',
      }),
    );
  });

  it('answers 422 with Payee not found problem when update outcome is PAYEE_NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.PAYEE_NOT_FOUND,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      params: { transactionId: mockTransaction.id },
      body: {
        payeeId: '00000000-0000-0000-0000-000000000002',
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.updateTransaction(mockTransaction.id, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.type).toHaveBeenCalledWith('application/problem+json');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Payee not found',
        detail: 'The specified payee was not found in this workspace.',
        status: 422,
        code: 'unprocessable',
      }),
    );
  });
});

describe('TransactionController.voidTransaction', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';
  const transactionId = '00000000-0000-0000-0000-000000000701';

  const mockVoidedTransaction: Transaction = {
    id: transactionId,
    type: 'expense',
    status: 'voided',
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
    version: 2,
  };

  const validBody = {
    reason: 'Voided due to customer cancellation',
  };

  function createMocks(ledgerPortOverrides: Partial<LedgerPort> = {}) {
    const fakeLedgerPort: LedgerPort = {
      create: vi.fn().mockResolvedValue({
        kind: TRANSACTION_CREATE_OUTCOMES.CREATED,
        transaction: mockVoidedTransaction,
      }),
      read: vi.fn().mockResolvedValue({
        kind: TRANSACTION_READ_OUTCOMES.OK,
        transaction: mockVoidedTransaction,
      }),
      list: vi.fn().mockResolvedValue({
        kind: TRANSACTION_LIST_OUTCOMES.OK,
        page: {
          items: [mockVoidedTransaction],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      update: vi.fn().mockResolvedValue({
        kind: TRANSACTION_UPDATE_OUTCOMES.OK,
        transaction: mockVoidedTransaction,
      }),
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.OK,
        transaction: mockVoidedTransaction,
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
        url: `/v1/transactions/${transactionId}/void`,
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

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 400 when transactionId is not a valid UUID', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction('not-a-uuid', request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 400 when Idempotency-Key header is missing or malformed', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.BAD_REQUEST }),
    );
  });

  it('answers 412 when If-Match header is malformed', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        'if-match': 'malformed-unquoted',
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(412);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.PRECONDITION_FAILED }),
    );
  });

  it('answers 422 with UNPROCESSABLE problem when void body validation fails (reason < 3 chars)', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: { reason: 'ab' },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        errors: expect.arrayContaining([
          expect.objectContaining({ field: 'reason', code: 'min-length' }),
        ]),
      }),
    );
  });

  it('answers 422 with UNPROCESSABLE problem when reason is absent', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {},
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        errors: expect.arrayContaining([
          expect.objectContaining({ field: 'reason', code: 'required' }),
        ]),
      }),
    );
  });

  it('answers 422 with UNPROCESSABLE problem when extra properties are provided', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: { reason: 'Valid reason', extra: 'unexpected' },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        errors: expect.arrayContaining([
          expect.objectContaining({ field: 'extra', code: 'not-allowed' }),
        ]),
      }),
    );
  });

  it('answers 403 when outcome is FORBIDDEN', async () => {
    const { controller, reply } = createMocks({
      void: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_VOID_OUTCOMES.FORBIDDEN }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.FORBIDDEN }),
    );
  });

  it('answers 404 when outcome is NOT_FOUND', async () => {
    const { controller, reply } = createMocks({
      void: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_VOID_OUTCOMES.NOT_FOUND }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.NOT_FOUND }),
    );
  });

  it('answers 409 when outcome is DRAFT (TRANSACTION_DRAFT)', async () => {
    const { controller, reply } = createMocks({
      void: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_VOID_OUTCOMES.DRAFT }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_DRAFT,
        title: 'Transaction is draft',
      }),
    );
  });

  it('answers 409 when outcome is VOIDED (TRANSACTION_VOIDED)', async () => {
    const { controller, reply } = createMocks({
      void: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_VOID_OUTCOMES.VOIDED }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_VOIDED,
        title: 'Transaction is voided',
      }),
    );
  });

  it('answers 409 when outcome is RECONCILED (TRANSACTION_RECONCILED)', async () => {
    const { controller, reply } = createMocks({
      void: vi
        .fn()
        .mockResolvedValue({ kind: TRANSACTION_VOID_OUTCOMES.RECONCILED }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSACTION_RECONCILED,
        title: 'Transaction is reconciled',
      }),
    );
  });

  it('answers 409 when outcome is IDEMPOTENCY_CONFLICT', async () => {
    const { controller, reply } = createMocks({
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.IDEMPOTENCY_CONFLICT,
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

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.CONFLICT }),
    );
  });

  it('answers 412 when outcome is VERSION_CONFLICT', async () => {
    const { controller, reply } = createMocks({
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT,
      }),
    });
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        'if-match': '"1"',
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(412);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: PROBLEM_TYPES.PRECONDITION_FAILED }),
    );
  });

  it('replays stored response when outcome is REPLAYED', async () => {
    const { controller, reply } = createMocks({
      void: vi.fn().mockResolvedValue({
        kind: TRANSACTION_VOID_OUTCOMES.REPLAYED,
        status: 200,
        etag: null,
        body: mockVoidedTransaction,
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

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(mockVoidedTransaction);
  });

  it('returns 200 with voided transaction body (NO ETag response header declared)', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
        'if-match': '"1"',
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.voidTransaction(transactionId, request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(mockVoidedTransaction);
    // ETag is not set on void response per OpenAPI declared spec
    expect(reply.header).not.toHaveBeenCalledWith('etag', expect.anything());
  });
});
