import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  RECONCILIATION_CREATE_OUTCOMES,
  RECONCILIATION_GET_OUTCOMES,
  type ReconciliationsPort,
  type Reconciliation,
} from '../../src/reconciliations/reconciliation.port.js';
import { ReconciliationsController } from '../../src/reconciliations/reconciliations.controller.js';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
const RECONCILIATION_ID = '00000000-0000-0000-0000-000000007001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000008001';

const MOCK_RECONCILIATION: Reconciliation = {
  id: RECONCILIATION_ID,
  accountId: ACCOUNT_ID,
  statementDate: '2026-08-31',
  statementBalance: {
    amountMinor: '10000',
    currency: 'USD',
  },
  systemBalance: {
    amountMinor: '8000',
    currency: 'USD',
  },
  difference: {
    amountMinor: '2000',
    currency: 'USD',
  },
  status: 'open',
  completedAt: null,
};

const VALID_CREATE_BODY = {
  accountId: ACCOUNT_ID,
  statementDate: '2026-08-31',
  statementBalance: {
    amountMinor: '10000',
    currency: 'USD',
  },
  notes: 'August reconciliation',
};

function createMocks() {
  const port: ReconciliationsPort = {
    createReconciliation: vi.fn(),
    getReconciliation: vi.fn(),
    completeReconciliation: vi.fn(),
  };

  const controller = new ReconciliationsController(port);

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
      url: '/v1/reconciliations',
    },
  } as unknown as FastifyReply;

  const createRequest = (
    headers: Record<string, string | undefined> = {},
    body: unknown = VALID_CREATE_BODY,
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

describe('ReconciliationsController', () => {
  describe('POST /v1/reconciliations', () => {
    it('returns 400 when X-Workspace-Id header is missing or invalid', async () => {
      const { controller, reply, createRequest, getStatus, getPayload } =
        createMocks();
      const req = createRequest({ 'idempotency-key': IDEMPOTENCY_KEY });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(400);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid X-Workspace-Id header',
        }),
      );
    });

    it('returns 400 when Idempotency-Key header is missing or invalid', async () => {
      const { controller, reply, createRequest, getStatus, getPayload } =
        createMocks();
      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(400);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid Idempotency-Key header',
        }),
      );
    });

    it('returns 422 when body validation fails', async () => {
      const { controller, reply, createRequest, getStatus, getPayload } =
        createMocks();
      const req = createRequest(
        {
          'x-workspace-id': WORKSPACE_ID,
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        { ...VALID_CREATE_BODY, accountId: 'not-a-uuid' },
      );

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(422);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 422,
          title: 'Reconciliation create validation failed',
        }),
      );
    });

    it('returns 403 when outcome is FORBIDDEN', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.FORBIDDEN,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(403);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 403,
          title: 'Workspace access forbidden',
        }),
      );
    });

    it('returns 409 when outcome is IDEMPOTENCY_CONFLICT', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(409);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 409,
          title: 'Idempotency key reused with different payload',
        }),
      );
    });

    it('returns 409 when outcome is OPEN_RECONCILIATION_EXISTS (RULING 71)', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.OPEN_RECONCILIATION_EXISTS,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(409);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 409,
          title: 'Open reconciliation already exists',
        }),
      );
    });

    it('returns 422 when outcome is ACCOUNT_NOT_FOUND (RULING 73)', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(422);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 422,
          title: 'Account unresolved',
        }),
      );
    });

    it('returns 422 when outcome is ACCOUNT_CLOSED (RULING 73)', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_CLOSED,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(422);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 422,
          title: 'Account is closed',
        }),
      );
    });

    it('returns 422 when outcome is CURRENCY_MISMATCH (RULING 70)', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.CURRENCY_MISMATCH,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(422);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 422,
          title: 'Currency mismatch',
        }),
      );
    });

    it('returns 422 when outcome is FUTURE_STATEMENT_DATE (RULING 72)', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.FUTURE_STATEMENT_DATE,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(422);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 422,
          title: 'Future statement date',
        }),
      );
    });

    it('returns 422 when outcome is AMOUNT_OUT_OF_RANGE (RULING 78)', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(422);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 422,
          title: 'Amount out of range',
        }),
      );
    });

    it('returns replayed response when outcome is REPLAYED', async () => {
      const {
        controller,
        port,
        reply,
        createRequest,
        getStatus,
        getHeaders,
        getPayload,
      } = createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.REPLAYED,
        status: 201,
        etag: '"v1"',
        body: MOCK_RECONCILIATION,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(201);
      expect(getHeaders()['etag']).toBe('"v1"');
      expect(getPayload()).toEqual(MOCK_RECONCILIATION);
    });

    it('returns 201 with reconciliation when outcome is CREATED', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.createReconciliation).mockResolvedValue({
        kind: RECONCILIATION_CREATE_OUTCOMES.CREATED,
        reconciliation: MOCK_RECONCILIATION,
      });

      const req = createRequest({
        'x-workspace-id': WORKSPACE_ID,
        'idempotency-key': IDEMPOTENCY_KEY,
      });

      await controller.createReconciliation(req, reply);
      expect(getStatus()).toBe(201);
      expect(getPayload()).toEqual(MOCK_RECONCILIATION);
    });
  });

  describe('GET /v1/reconciliations/:reconciliationId', () => {
    it('returns 400 when X-Workspace-Id header is missing or invalid', async () => {
      const { controller, reply, createRequest, getStatus, getPayload } =
        createMocks();
      const req = createRequest({});

      await controller.getReconciliation(RECONCILIATION_ID, req, reply);
      expect(getStatus()).toBe(400);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid X-Workspace-Id header',
        }),
      );
    });

    it('returns 400 when reconciliationId param is invalid', async () => {
      const { controller, reply, createRequest, getStatus, getPayload } =
        createMocks();
      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.getReconciliation('invalid-uuid', req, reply);
      expect(getStatus()).toBe(400);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid reconciliation identifier',
        }),
      );
    });

    it('returns 403 when outcome is FORBIDDEN', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.getReconciliation).mockResolvedValue({
        kind: RECONCILIATION_GET_OUTCOMES.FORBIDDEN,
      });

      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.getReconciliation(RECONCILIATION_ID, req, reply);
      expect(getStatus()).toBe(403);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 403,
          title: 'Workspace access forbidden',
        }),
      );
    });

    it('returns 404 when outcome is NOT_FOUND', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.getReconciliation).mockResolvedValue({
        kind: RECONCILIATION_GET_OUTCOMES.NOT_FOUND,
      });

      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.getReconciliation(RECONCILIATION_ID, req, reply);
      expect(getStatus()).toBe(404);
      expect(getPayload()).toEqual(
        expect.objectContaining({
          status: 404,
          title: 'Reconciliation not found',
        }),
      );
    });

    it('returns 200 with reconciliation when outcome is FOUND', async () => {
      const { controller, port, reply, createRequest, getStatus, getPayload } =
        createMocks();
      vi.mocked(port.getReconciliation).mockResolvedValue({
        kind: RECONCILIATION_GET_OUTCOMES.FOUND,
        reconciliation: MOCK_RECONCILIATION,
      });

      const req = createRequest({ 'x-workspace-id': WORKSPACE_ID });

      await controller.getReconciliation(RECONCILIATION_ID, req, reply);
      expect(getStatus()).toBe(200);
      expect(getPayload()).toEqual(MOCK_RECONCILIATION);
      expect(port.getReconciliation).toHaveBeenCalledWith(
        SUBJECT,
        WORKSPACE_ID,
        RECONCILIATION_ID,
      );
    });
  });
});
