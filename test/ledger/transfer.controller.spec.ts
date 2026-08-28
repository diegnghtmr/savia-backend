import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { TransferController } from '../../src/ledger/transfer.controller.js';
import {
  TRANSFER_CREATE_OUTCOMES,
  type Transfer,
  type TransferPort,
} from '../../src/ledger/transfer.port.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

describe('TransferController.createTransfer', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';
  const sourceAccountId = '00000000-0000-0000-0000-000000000a01';
  const destinationAccountId = '00000000-0000-0000-0000-000000000a02';

  const mockTransfer: Transfer = {
    id: '00000000-0000-0000-0000-000000000tr1',
    sourceAccountId,
    destinationAccountId,
    sourceAmount: { amountMinor: '5000', currency: 'USD' },
    destinationAmount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-08-25T10:00:00.000Z',
    status: 'confirmed',
  };

  const validBody = {
    sourceAccountId,
    destinationAccountId,
    amount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-08-25T10:00:00.000Z',
    description: 'Test transfer',
  };

  function createMocks(transferPortOverrides: Partial<TransferPort> = {}) {
    const fakeTransferPort: TransferPort = {
      create: vi.fn().mockResolvedValue({
        kind: TRANSFER_CREATE_OUTCOMES.CREATED,
        transfer: mockTransfer,
      }),
      ...transferPortOverrides,
    };

    const controller = new TransferController(fakeTransferPort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: '/v1/transfers',
      },
    } as unknown as FastifyReply;

    return { controller, fakeTransferPort, reply };
  }

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'idempotency-key': idempotencyKey },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
      }),
    );
  });

  it('answers 400 when Idempotency-Key header is missing', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'x-workspace-id': workspaceId },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
      }),
    );
  });

  it('answers 422 when body validation fails (e.g. self-transfer)', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {
        ...validBody,
        destinationAccountId: sourceAccountId,
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Transfer create validation failed',
      }),
    );
  });

  it('answers 201 with created transfer body and NO ETag header', async () => {
    const { controller, reply, fakeTransferPort } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createTransfer(request, reply);

    expect(fakeTransferPort.create).toHaveBeenCalledWith(
      subject,
      workspaceId,
      expect.objectContaining({
        sourceAccountId,
        destinationAccountId,
      }),
      idempotencyKey,
    );
    expect(reply.header).not.toHaveBeenCalledWith('etag', expect.anything());
    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith(mockTransfer);
  });

  it('answers 403 when port reports forbidden', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSFER_CREATE_OUTCOMES.FORBIDDEN,
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

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
      }),
    );
  });

  it('answers 409 when port reports idempotency conflict', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSFER_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
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

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
      }),
    );
  });

  it('answers 422 when port reports account unresolved', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
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

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.ACCOUNT_UNRESOLVED,
        title: 'Account unresolved',
      }),
    );
  });

  it('answers 422 when port reports account closed', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED,
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

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.ACCOUNT_CLOSED,
        title: 'Account is closed',
      }),
    );
  });

  it('answers 422 when port reports currency mismatch', async () => {
    const { controller, reply } = createMocks({
      create: vi.fn().mockResolvedValue({
        kind: TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH,
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

    await controller.createTransfer(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSFER_CURRENCY_MISMATCH,
        title: 'Transfer currency mismatch',
      }),
    );
  });
});
