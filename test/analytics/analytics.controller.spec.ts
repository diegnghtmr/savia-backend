import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  ANALYTICS_OUTCOMES,
  type AnalyticsPort,
  type AnalyticsSummary,
  type CashFlowAnalytics,
} from '../../src/analytics/analytics.port.js';
import { AnalyticsController } from '../../src/analytics/analytics.controller.js';

interface MockReply {
  statusCode: number;
  sentBody: unknown;
  contentType: string | undefined;
  request: { id: string; url: string };
  status(code: number): MockReply;
  type(ct: string): MockReply;
  send(body: unknown): MockReply;
}

type ProblemBody = {
  title?: string;
  detail?: string;
  errors?: unknown;
};

describe('AnalyticsController', () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';

  const mockReply = () => {
    const res: MockReply = {
      statusCode: 200,
      sentBody: undefined,
      contentType: undefined,
      request: { id: 'req-1', url: '/v1/analytics/summary' },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type(ct: string) {
        this.contentType = ct;
        return this;
      },
      send(body: unknown) {
        this.sentBody = body;
        return this;
      },
    };
    return res as unknown as FastifyReply & {
      statusCode: number;
      sentBody: unknown;
    };
  };

  const mockReq = (
    headers: Record<string, string | undefined> = {
      'x-workspace-id': workspaceId,
    },
  ) =>
    ({
      headers,
      identity: { subject: 'sub-1' },
    }) as unknown as AuthenticatedRequest;

  it('returns 400 when X-Workspace-Id header is missing', async () => {
    const port: AnalyticsPort = {
      getSummary: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getCashFlow: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getAdvancedAnalytics: async () => ({
        kind: ANALYTICS_OUTCOMES.FORBIDDEN,
      }),
    };
    const controller = new AnalyticsController(port);
    const reply = mockReply();
    await controller.getSummary(mockReq({}), reply, '2026-01-01', '2026-01-31');
    expect(reply.statusCode).toBe(400);
    expect((reply.sentBody as ProblemBody)?.title).toBe(
      'Invalid X-Workspace-Id header',
    );
  });

  it('returns 400 when query validation fails', async () => {
    const port: AnalyticsPort = {
      getSummary: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getCashFlow: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getAdvancedAnalytics: async () => ({
        kind: ANALYTICS_OUTCOMES.FORBIDDEN,
      }),
    };
    const controller = new AnalyticsController(port);
    const reply = mockReply();
    // from > to
    await controller.getSummary(mockReq(), reply, '2026-02-01', '2026-01-01');
    expect(reply.statusCode).toBe(400);
    expect((reply.sentBody as ProblemBody)?.errors).toBeDefined();
  });

  it('returns 400 with missing currency pair when missing rate occurs', async () => {
    const port: AnalyticsPort = {
      getSummary: async () => ({
        kind: ANALYTICS_OUTCOMES.MISSING_RATE,
        fromCurrency: 'EUR',
        toCurrency: 'USD',
      }),
      getCashFlow: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getAdvancedAnalytics: async () => ({
        kind: ANALYTICS_OUTCOMES.FORBIDDEN,
      }),
    };
    const controller = new AnalyticsController(port);
    const reply = mockReply();
    await controller.getSummary(
      mockReq(),
      reply,
      '2026-01-01',
      '2026-01-31',
      'USD',
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.sentBody as ProblemBody)?.detail).toContain('EUR');
    expect((reply.sentBody as ProblemBody)?.detail).toContain('USD');
  });

  it('returns 200 on summary success', async () => {
    const mockSummary: AnalyticsSummary = {
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      baseCurrency: 'USD',
      netWorth: { amountMinor: '1000', currency: 'USD' },
      assets: { amountMinor: '1000', currency: 'USD' },
      debts: { amountMinor: '0', currency: 'USD' },
      income: { amountMinor: '1000', currency: 'USD' },
      expenses: { amountMinor: '0', currency: 'USD' },
      savingsCapacity: { amountMinor: '1000', currency: 'USD' },
    };
    const port: AnalyticsPort = {
      getSummary: async () => ({
        kind: ANALYTICS_OUTCOMES.OK,
        summary: mockSummary,
      }),
      getCashFlow: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getAdvancedAnalytics: async () => ({
        kind: ANALYTICS_OUTCOMES.FORBIDDEN,
      }),
    };
    const controller = new AnalyticsController(port);
    const reply = mockReply();
    await controller.getSummary(mockReq(), reply, '2026-01-01', '2026-01-31');
    expect(reply.statusCode).toBe(200);
    expect(reply.sentBody).toEqual(mockSummary);
  });

  it('returns 200 on cash-flow success', async () => {
    const mockCashFlow: CashFlowAnalytics = {
      series: [],
      categories: [],
    };
    const port: AnalyticsPort = {
      getSummary: async () => ({ kind: ANALYTICS_OUTCOMES.FORBIDDEN }),
      getCashFlow: async () => ({
        kind: ANALYTICS_OUTCOMES.OK,
        analytics: mockCashFlow,
      }),
      getAdvancedAnalytics: async () => ({
        kind: ANALYTICS_OUTCOMES.FORBIDDEN,
      }),
    };
    const controller = new AnalyticsController(port);
    const reply = mockReply();
    await controller.getCashFlow(
      mockReq(),
      reply,
      '2026-01-01',
      '2026-01-31',
      'month',
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.sentBody).toEqual(mockCashFlow);
  });
});
