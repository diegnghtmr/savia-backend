import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { ExchangeRateController } from '../../src/currencies/exchange-rate.controller.js';
import {
  EXCHANGE_RATE_CREATE_OUTCOMES,
  type ExchangeRate,
  type ExchangeRatePort,
} from '../../src/currencies/exchange-rate.port.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

describe('ExchangeRateController.createManualExchangeRate', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

  const mockExchangeRate: ExchangeRate = {
    id: '00000000-0000-0000-0000-000000000fx1',
    baseCurrency: 'USD',
    quoteCurrency: 'EUR',
    rate: '0.9200',
    effectiveAt: '2026-08-28T12:00:00.000Z',
    source: 'manual',
    manual: true,
  };

  const validBody = {
    baseCurrency: 'USD',
    quoteCurrency: 'EUR',
    rate: '0.9200',
    effectiveAt: '2026-08-28T12:00:00.000Z',
    notes: 'Test manual rate',
  };

  function createMocks(
    exchangeRatePortOverrides: Partial<ExchangeRatePort> = {},
  ) {
    const fakeExchangeRatePort: ExchangeRatePort = {
      createManual: vi.fn().mockResolvedValue({
        kind: EXCHANGE_RATE_CREATE_OUTCOMES.CREATED,
        exchangeRate: mockExchangeRate,
      }),
      ...exchangeRatePortOverrides,
    };

    const controller = new ExchangeRateController(fakeExchangeRatePort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: '/v1/exchange-rates',
      },
    } as unknown as FastifyReply;

    return { controller, fakeExchangeRatePort, reply };
  }

  it('answers 400 when X-Workspace-Id header is missing', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: { 'idempotency-key': idempotencyKey },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createManualExchangeRate(request, reply);
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

    await controller.createManualExchangeRate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
      }),
    );
  });

  it('answers 422 when body validation fails (e.g. non-positive rate)', async () => {
    const { controller, reply } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: {
        ...validBody,
        rate: '-1.00',
      },
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createManualExchangeRate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Manual exchange rate create validation failed',
      }),
    );
  });

  it('answers 201 with created exchange rate body and NO ETag header', async () => {
    const { controller, reply, fakeExchangeRatePort } = createMocks();
    const request = {
      headers: {
        'x-workspace-id': workspaceId,
        'idempotency-key': idempotencyKey,
      },
      body: validBody,
      identity: { subject },
    } as unknown as AuthenticatedRequest;

    await controller.createManualExchangeRate(request, reply);

    expect(fakeExchangeRatePort.createManual).toHaveBeenCalledWith(
      subject,
      workspaceId,
      expect.objectContaining({
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.9200',
      }),
      idempotencyKey,
    );
    expect(reply.header).not.toHaveBeenCalledWith('etag', expect.anything());
    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith(mockExchangeRate);
  });

  it('answers 403 when port reports forbidden', async () => {
    const { controller, reply } = createMocks({
      createManual: vi.fn().mockResolvedValue({
        kind: EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN,
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

    await controller.createManualExchangeRate(request, reply);
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
      createManual: vi.fn().mockResolvedValue({
        kind: EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
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

    await controller.createManualExchangeRate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
      }),
    );
  });

  it('answers 409 when port reports exchange rate already recorded', async () => {
    const { controller, reply } = createMocks({
      createManual: vi.fn().mockResolvedValue({
        kind: EXCHANGE_RATE_CREATE_OUTCOMES.ALREADY_RECORDED,
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

    await controller.createManualExchangeRate(request, reply);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PROBLEM_TYPES.EXCHANGE_RATE_ALREADY_RECORDED,
        title: 'Exchange rate already recorded',
      }),
    );
  });
});
