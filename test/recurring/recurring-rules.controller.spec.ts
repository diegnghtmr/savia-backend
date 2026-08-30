import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  RECURRING_CREATE_OUTCOMES,
  RECURRING_LIST_OUTCOMES,
  type RecurringRulesPort,
  type RecurringRule,
} from '../../src/recurring/recurring.port.js';
import { RecurringRulesController } from '../../src/recurring/recurring-rules.controller.js';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';

const MOCK_RULE: RecurringRule = {
  id: '00000000-0000-0000-0000-000000001001',
  name: 'Gym Membership',
  frequency: 'monthly',
  rrule: null,
  behavior: 'create_draft',
  template: {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000002001',
    amount: {
      amountMinor: '4500',
      currency: 'USD',
    },
    occurredAt: '2026-08-29T12:00:00.000Z',
    status: 'draft',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: null,
    tagIds: [],
    receiptId: null,
  },
  active: true,
  nextOccurrenceAt: '2026-09-29T12:00:00.000Z',
};

const VALID_BODY = {
  name: 'Gym Membership',
  frequency: 'monthly',
  behavior: 'create_draft',
  template: {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000002001',
    amount: {
      amountMinor: '4500',
      currency: 'USD',
    },
    occurredAt: '2026-08-29T12:00:00.000Z',
  },
  startsAt: '2026-08-29T12:00:00.000Z',
};

function createMocks() {
  const port: RecurringRulesPort = {
    createRecurringRule: vi.fn(),
    listRecurringRules: vi.fn(),
    listSubscriptions: vi.fn(),
  };

  const controller = new RecurringRulesController(port);

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
      url: '/v1/recurring-rules',
    },
  } as unknown as FastifyReply;

  const createRequest = (
    headers: Record<string, string | undefined> = {},
    body: unknown = VALID_BODY,
  ): AuthenticatedRequest =>
    ({
      headers,
      body,
      identity: { subject: SUBJECT },
    }) as unknown as AuthenticatedRequest;

  return {
    controller,
    port,
    reply,
    getStatus: () => sentStatus,
    getHeaders: () => sentHeaders,
    getPayload: () => sentPayload,
    createRequest,
  };
}

describe('RecurringRulesController', () => {
  describe('createRecurringRule', () => {
    it('returns 400 when X-Workspace-Id header is missing or invalid', async () => {
      const { controller, reply, createRequest, getStatus } = createMocks();
      const req = createRequest({ 'idempotency-key': IDEMPOTENCY_KEY });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(400);
    });

    it('returns 400 when Idempotency-Key header is missing or invalid', async () => {
      const { controller, reply, createRequest, getStatus } = createMocks();
      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(400);
    });

    it('returns 422 when body validation fails', async () => {
      const { controller, reply, createRequest, getStatus } = createMocks();
      const req = createRequest(
        {
          'x-workspace-id': WORKSPACE_ID,
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        { ...VALID_BODY, name: '' }, // empty name
      );

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(422);
    });

    it('returns 403 when port answers FORBIDDEN', async () => {
      const { controller, port, reply, createRequest, getStatus } =
        createMocks();
      vi.mocked(port.createRecurringRule).mockResolvedValue({
        kind: RECURRING_CREATE_OUTCOMES.FORBIDDEN,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(403);
    });

    it('returns 409 when port answers IDEMPOTENCY_CONFLICT', async () => {
      const { controller, port, reply, createRequest, getStatus } =
        createMocks();
      vi.mocked(port.createRecurringRule).mockResolvedValue({
        kind: RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(409);
    });

    it('returns 422 when port answers ACCOUNT_NOT_FOUND (RULING 53)', async () => {
      const { controller, port, reply, createRequest, getStatus } =
        createMocks();
      vi.mocked(port.createRecurringRule).mockResolvedValue({
        kind: RECURRING_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(422);
    });

    it('returns 201 with created rule on success', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createRecurringRule).mockResolvedValue({
        kind: RECURRING_CREATE_OUTCOMES.CREATED,
        rule: MOCK_RULE,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(201);
      expect(getPayload()).toEqual(MOCK_RULE);
    });

    it('returns replayed status and payload on idempotency match', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createRecurringRule).mockResolvedValue({
        kind: RECURRING_CREATE_OUTCOMES.REPLAYED,
        status: 201,
        etag: null,
        body: MOCK_RULE,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createRecurringRule(req, reply);
      expect(getStatus()).toBe(201);
      expect(getPayload()).toEqual(MOCK_RULE);
    });
  });

  describe('listRecurringRules', () => {
    it('returns 400 when X-Workspace-Id header is missing', async () => {
      const { controller, reply, createRequest, getStatus } = createMocks();
      const req = createRequest({});

      await controller.listRecurringRules(req, reply);
      expect(getStatus()).toBe(400);
    });

    it('returns 400 when query parameter validation fails (e.g. invalid limit)', async () => {
      const { controller, reply, createRequest, getStatus } = createMocks();
      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.listRecurringRules(
        req,
        reply,
        undefined,
        'not-a-number',
      );
      expect(getStatus()).toBe(400);
    });

    it('returns 403 when port answers FORBIDDEN', async () => {
      const { controller, port, reply, createRequest, getStatus } =
        createMocks();
      vi.mocked(port.listRecurringRules).mockResolvedValue({
        kind: RECURRING_LIST_OUTCOMES.FORBIDDEN,
      });

      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.listRecurringRules(req, reply);
      expect(getStatus()).toBe(403);
    });

    it('returns 200 with page on success', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      const mockPage = {
        items: [MOCK_RULE],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
      vi.mocked(port.listRecurringRules).mockResolvedValue({
        kind: RECURRING_LIST_OUTCOMES.OK,
        page: mockPage,
      });

      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.listRecurringRules(req, reply, undefined, '50');
      expect(getStatus()).toBe(200);
      expect(getPayload()).toEqual(mockPage);
    });
  });
});
