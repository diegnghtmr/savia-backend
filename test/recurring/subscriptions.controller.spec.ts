import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  SUBSCRIPTION_LIST_OUTCOMES,
  type RecurringRulesPort,
  type Subscription,
} from '../../src/recurring/recurring.port.js';
import { SubscriptionsController } from '../../src/recurring/subscriptions.controller.js';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const MOCK_SUBSCRIPTION: Subscription = {
  id: '00000000-0000-0000-0000-000000006001',
  payeeName: 'Spotify',
  currentAmount: {
    amountMinor: '999',
    currency: 'USD',
  },
  previousAmount: {
    amountMinor: '899',
    currency: 'USD',
  },
  increasePercent: 11.12,
  frequency: 'monthly',
  nextExpectedAt: '2026-09-29T12:00:00.000Z',
  status: 'confirmed',
};

function createMocks() {
  const port: RecurringRulesPort = {
    createRecurringRule: vi.fn(),
    listRecurringRules: vi.fn(),
    listSubscriptions: vi.fn(),
  };

  const controller = new SubscriptionsController(port);

  let sentStatus: number | undefined;
  const sentHeaders: Record<string, string> = {};
  let sentPayload: unknown;

  const reply = {
    status: vi.fn((code: number) => {
      sentStatus = code;
      return reply;
    }),
    type: vi.fn(() => reply),
    header: vi.fn((name: string, value: string) => {
      sentHeaders[name.toLowerCase()] = value;
      return reply;
    }),
    send: vi.fn((payload: unknown) => {
      sentPayload = payload;
      return reply;
    }),
    request: {
      id: 'trace-123',
      url: '/v1/subscriptions',
    },
  } as unknown as FastifyReply;

  const createRequest = (
    headers: Record<string, string | undefined> = {},
  ): AuthenticatedRequest =>
    ({
      headers,
      identity: { subject: SUBJECT },
    }) as unknown as AuthenticatedRequest;

  return {
    port,
    controller,
    reply,
    createRequest,
    getSentStatus: () => sentStatus,
    getSentPayload: () => sentPayload,
  };
}

describe('SubscriptionsController', () => {
  describe('GET /v1/subscriptions', () => {
    it('answers 400 when X-Workspace-Id header is missing', async () => {
      const {
        controller,
        reply,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      await controller.listSubscriptions(createRequest({}), reply);

      expect(getSentStatus()).toBe(400);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid X-Workspace-Id header',
        }),
      );
    });

    it('answers 400 when X-Workspace-Id header is invalid', async () => {
      const {
        controller,
        reply,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      await controller.listSubscriptions(
        createRequest({ 'x-workspace-id': 'invalid-uuid' }),
        reply,
      );

      expect(getSentStatus()).toBe(400);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid X-Workspace-Id header',
        }),
      );
    });

    it('answers 400 when status filter is invalid (RULING 61: 400, not 422)', async () => {
      const {
        controller,
        reply,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      await controller.listSubscriptions(
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
        undefined,
        undefined,
        'invalid_status',
      );

      expect(getSentStatus()).toBe(400);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid list subscriptions query',
          errors: expect.arrayContaining([
            expect.objectContaining({
              field: 'status',
              code: 'invalid',
            }),
          ]),
        }),
      );
    });

    it('answers 400 when limit is invalid', async () => {
      const {
        controller,
        reply,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      await controller.listSubscriptions(
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
        undefined,
        'not-a-number',
      );

      expect(getSentStatus()).toBe(400);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid list subscriptions query',
        }),
      );
    });

    it('answers 403 when access is forbidden', async () => {
      const {
        controller,
        reply,
        port,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      port.listSubscriptions = vi.fn().mockResolvedValue({
        kind: SUBSCRIPTION_LIST_OUTCOMES.FORBIDDEN,
      });

      await controller.listSubscriptions(
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
      );

      expect(getSentStatus()).toBe(403);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 403,
          title: 'Workspace access forbidden',
        }),
      );
    });

    it('answers 200 with subscription page when valid', async () => {
      const {
        controller,
        reply,
        port,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      const mockPage = {
        items: [MOCK_SUBSCRIPTION],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };

      port.listSubscriptions = vi.fn().mockResolvedValue({
        kind: SUBSCRIPTION_LIST_OUTCOMES.OK,
        page: mockPage,
      });

      await controller.listSubscriptions(
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
        undefined,
        '10',
        'confirmed',
      );

      expect(getSentStatus()).toBe(200);
      expect(getSentPayload()).toEqual(mockPage);
      expect(port.listSubscriptions).toHaveBeenCalledWith(
        SUBJECT,
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          limit: 10,
          status: 'confirmed',
        }),
      );
    });
  });
});
