import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import type { Job } from '../../src/jobs/job.port.js';
import {
  FORECAST_OUTCOMES,
  type Forecast,
  type ForecastsPort,
} from '../../src/forecasts/forecast.port.js';
import { ForecastsController } from '../../src/forecasts/forecasts.controller.js';

describe('ForecastsController', () => {
  const subject = '11111111-0000-4000-8000-000000000001';
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const idempotencyKey = 'bbbbbbbb-0000-4000-8000-000000000001';
  const forecastId = 'ffffffff-0000-4000-8000-000000000001';

  const validBody = {
    horizonDays: 30,
    includeScenarios: false,
  };

  const sampleJob: Job = {
    id: 'jjjjjjjj-0000-4000-8000-000000000001',
    type: 'balance_forecast',
    status: 'completed',
    progressPercent: 100,
    resultResourceId: forecastId,
    error: null,
    createdAt: '2026-09-04T12:00:00.000Z',
    startedAt: '2026-09-04T12:00:00.000Z',
    completedAt: '2026-09-04T12:00:00.000Z',
  };

  const sampleForecast: Forecast = {
    id: forecastId,
    status: 'completed',
    generatedAt: '2026-09-04T12:00:00.000Z',
    confidence: 'high',
    assumptions: [],
    series: [],
    method: 'mean-monthly-flow-with-population-stddev-bounds',
  };

  function createReplyMock() {
    let sentStatus = 200;
    let sentPayload: unknown = undefined;
    const sentHeader: Record<string, string> = {};

    const reply = {
      code: vi.fn((code: number) => {
        sentStatus = code;
        return reply;
      }),
      status: vi.fn((code: number) => {
        sentStatus = code;
        return reply;
      }),
      type: vi.fn((ct: string) => {
        sentHeader['content-type'] = ct;
        return reply;
      }),
      header: vi.fn((name: string, val: string) => {
        sentHeader[name] = val;
        return reply;
      }),
      send: vi.fn((payload: unknown) => {
        sentPayload = payload;
        return reply;
      }),
      request: { id: 'req-1', url: '/v1/forecasts' },
      getStatus: () => sentStatus,
      getPayload: () => sentPayload,
    } as unknown as FastifyReply & {
      getStatus: () => number;
      getPayload: () => unknown;
    };

    return reply;
  }

  function createRequestMock(options: {
    workspaceIdHeader?: string | string[] | undefined;
    idempotencyKeyHeader?: string | undefined;
    body?: unknown;
  }): AuthenticatedRequest {
    const headers: Record<string, string | string[] | undefined> = {};
    if (options.workspaceIdHeader !== undefined) {
      headers['x-workspace-id'] = options.workspaceIdHeader;
    }
    if (options.idempotencyKeyHeader !== undefined) {
      headers['idempotency-key'] = options.idempotencyKeyHeader;
    }

    return {
      identity: {
        subject,
        issuer: 'https://issuer.example.test',
        audience: 'savia-api',
        claims: {},
      },
      headers,
      body: options.body,
    } as unknown as AuthenticatedRequest;
  }

  function createMockPort(overrides?: Partial<ForecastsPort>): ForecastsPort {
    return {
      createBalanceForecast: vi.fn(),
      getForecast: vi.fn(),
      ...overrides,
    };
  }

  describe('POST /v1/forecasts/balance', () => {
    it('returns 400 when X-Workspace-Id header is missing or invalid', async () => {
      const port = createMockPort();
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: undefined,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(400);
      const payload = reply.getPayload() as { type: string; title: string };
      expect(payload.title).toBe('Invalid X-Workspace-Id header');
    });

    it('returns 400 when Idempotency-Key header is missing or invalid', async () => {
      const port = createMockPort();
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: 'not-a-valid-uuid',
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(400);
      const payload = reply.getPayload() as { type: string; title: string };
      expect(payload.title).toBe('Invalid Idempotency-Key header');
    });

    it('returns 422 when body validation fails', async () => {
      const port = createMockPort();
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: { horizonDays: -5 }, // invalid horizonDays
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(422);
      const payload = reply.getPayload() as { type: string; title: string };
      expect(payload.title).toBe('Forecast validation failed');
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const port = createMockPort({
        createBalanceForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.FORBIDDEN,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(403);
    });

    it('returns 409 when port returns CONFLICT', async () => {
      const port = createMockPort({
        createBalanceForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.CONFLICT,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(409);
    });

    it('returns replayed response when port returns REPLAYED', async () => {
      const port = createMockPort({
        createBalanceForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.REPLAYED,
          status: 202,
          body: sampleJob,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(202);
      expect(reply.getPayload()).toEqual(sampleJob);
    });

    it('returns 422 when port returns MISSING_RATE', async () => {
      const port = createMockPort({
        createBalanceForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.MISSING_RATE,
          fromCurrency: 'EUR',
          toCurrency: 'USD',
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(422);
      const payload = reply.getPayload() as { detail: string };
      expect(payload.detail).toContain('Missing exchange rate from EUR to USD');
    });

    it('returns 422 when port returns UNPROCESSABLE with violations', async () => {
      const port = createMockPort({
        createBalanceForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.UNPROCESSABLE,
          violations: [{ field: 'accountIds', message: 'Unknown account id' }],
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(422);
      const payload = reply.getPayload() as {
        errors: readonly { field: string; message: string }[];
      };
      expect(payload.errors[0]?.field).toBe('accountIds');
    });

    it('returns 202 with Job body when port returns ACCEPTED', async () => {
      const port = createMockPort({
        createBalanceForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.ACCEPTED,
          job: sampleJob,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.createBalance(req, reply);

      expect(reply.getStatus()).toBe(202);
      expect(reply.getPayload()).toEqual(sampleJob);
    });
  });

  describe('GET /v1/forecasts/:forecastId', () => {
    it('returns 400 when X-Workspace-Id header is missing', async () => {
      const port = createMockPort();
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: undefined,
      });

      await controller.get(forecastId, req, reply);

      expect(reply.getStatus()).toBe(400);
      const payload = reply.getPayload() as { title: string };
      expect(payload.title).toBe('Invalid X-Workspace-Id header');
    });

    it('returns 400 when forecastId is not a valid UUID', async () => {
      const port = createMockPort();
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
      });

      await controller.get('not-a-valid-uuid', req, reply);

      expect(reply.getStatus()).toBe(400);
      const payload = reply.getPayload() as { title: string };
      expect(payload.title).toBe('Invalid forecast identifier');
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const port = createMockPort({
        getForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.FORBIDDEN,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
      });

      await controller.get(forecastId, req, reply);

      expect(reply.getStatus()).toBe(403);
    });

    it('returns 404 when port returns NOT_FOUND', async () => {
      const port = createMockPort({
        getForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.NOT_FOUND,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
      });

      await controller.get(forecastId, req, reply);

      expect(reply.getStatus()).toBe(404);
      const payload = reply.getPayload() as { title: string };
      expect(payload.title).toBe('Forecast not found');
    });

    it('returns 200 with forecast when port returns OK', async () => {
      const port = createMockPort({
        getForecast: vi.fn().mockResolvedValueOnce({
          kind: FORECAST_OUTCOMES.OK,
          forecast: sampleForecast,
        }),
      });
      const controller = new ForecastsController(port);
      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
      });

      await controller.get(forecastId, req, reply);

      expect(reply.getStatus()).toBe(200);
      expect(reply.getPayload()).toEqual(sampleForecast);
    });
  });
});
