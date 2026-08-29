import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { CurrencyExchangeController } from '../../src/ledger/currency-exchange.controller.js';
import {
  CURRENCY_EXCHANGE_CREATE_OUTCOMES,
  type CurrencyExchangePort,
} from '../../src/ledger/currency-exchange.port.js';
import type { Transfer } from '../../src/ledger/transfer.port.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

describe('CurrencyExchangeController.createCurrencyExchange', () => {
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
    destinationAmount: { amountMinor: '4600', currency: 'EUR' },
    exchangeRate: '0.9200',
    occurredAt: '2026-08-25T10:00:00.000Z',
    status: 'confirmed',
  };

  const validBody = {
    sourceAccountId,
    destinationAccountId,
    sourceAmount: { amountMinor: '5000', currency: 'USD' },
    destinationAmount: { amountMinor: '4600', currency: 'EUR' },
    executedRate: '0.9200',
    occurredAt: '2026-08-25T10:00:00.000Z',
    description: 'Test exchange',
  };

  function createMocks(
    currencyExchangePortOverrides: Partial<CurrencyExchangePort> = {},
  ) {
    const fakeCurrencyExchangePort: CurrencyExchangePort = {
      create: vi.fn().mockResolvedValue({
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED,
        transfer: mockTransfer,
      }),
      ...currencyExchangePortOverrides,
    };

    const controller = new CurrencyExchangeController(fakeCurrencyExchangePort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: '/v1/currency-exchanges',
      },
    } as unknown as FastifyReply;

    return { controller, fakeCurrencyExchangePort, reply };
  }

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'idempotency-key': idempotencyKey },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createCurrencyExchange(request, reply);
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

    await controller.createCurrencyExchange(request, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
      }),
    );
  });

  it('answers 422 when body validation fails (e.g. self-exchange)', async () => {
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

    await controller.createCurrencyExchange(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Currency exchange create validation failed',
      }),
    );
  });

  it('answers 201 with created transfer body and NO ETag header', async () => {
    const { controller, reply, fakeCurrencyExchangePort } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createCurrencyExchange(request, reply);

    expect(fakeCurrencyExchangePort.create).toHaveBeenCalledWith(
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
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN,
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

    await controller.createCurrencyExchange(request, reply);
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
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
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

    await controller.createCurrencyExchange(request, reply);
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
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
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

    await controller.createCurrencyExchange(request, reply);
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
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_CLOSED,
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

    await controller.createCurrencyExchange(request, reply);
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
        kind: CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
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

    await controller.createCurrencyExchange(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.TRANSFER_CURRENCY_MISMATCH,
        title: 'Transfer currency mismatch',
      }),
    );
  });
});
