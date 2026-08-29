import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { PayeesController } from '../../src/catalogs/payees.controller.js';
import {
  CATALOG_CREATE_OUTCOMES,
  CATALOG_LIST_OUTCOMES,
  type CatalogsPort,
  type Payee,
} from '../../src/catalogs/catalogs.port.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

describe('PayeesController', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

  const mockPayee: Payee = {
    id: '00000000-0000-0000-0000-000000002001',
    name: 'Acme Supermarket',
    archived: false,
  };

  const validBody = {
    name: 'Acme Supermarket',
  };

  function createMocks(catalogsPortOverrides: Partial<CatalogsPort> = {}) {
    const fakeCatalogsPort: CatalogsPort = {
      createTag: vi.fn(),
      listTags: vi.fn(),
      createPayee: vi.fn().mockResolvedValue({
        kind: CATALOG_CREATE_OUTCOMES.CREATED,
        payee: mockPayee,
      }),
      listPayees: vi.fn().mockResolvedValue({
        kind: CATALOG_LIST_OUTCOMES.OK,
        page: {
          items: [mockPayee],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      ...catalogsPortOverrides,
    };

    const controller = new PayeesController(fakeCatalogsPort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: '/v1/payees',
      },
    } as unknown as FastifyReply;

    return { controller, fakeCatalogsPort, reply };
  }

  describe('createPayee', () => {
    it('answers 400 when X-Workspace-Id header is missing or malformed', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: { 'idempotency-key': idempotencyKey },
        body: validBody,
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid X-Workspace-Id header',
        }),
      );
    });

    it('answers 400 when Idempotency-Key header is missing or invalid', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: { 'x-workspace-id': workspaceId },
        body: validBody,
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid Idempotency-Key header',
        }),
      );
    });

    it('answers 422 when body validation fails', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        body: { name: '' },
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(422);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Payee create validation failed',
        }),
      );
    });

    it('answers 201 with payee when created successfully', async () => {
      const { controller, reply, fakeCatalogsPort } = createMocks();
      const request = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        body: validBody,
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.createPayee(request, reply);
      expect(fakeCatalogsPort.createPayee).toHaveBeenCalledWith(
        subject,
        workspaceId,
        validBody,
        idempotencyKey,
      );
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(mockPayee);
    });

    it('answers 403 when outcome is forbidden', async () => {
      const { controller, reply } = createMocks({
        createPayee: vi.fn().mockResolvedValue({
          kind: CATALOG_CREATE_OUTCOMES.FORBIDDEN,
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

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.FORBIDDEN,
        }),
      );
    });

    it('answers 409 when outcome is idempotency conflict', async () => {
      const { controller, reply } = createMocks({
        createPayee: vi.fn().mockResolvedValue({
          kind: CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
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

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(409);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Idempotency key reused with different payload',
        }),
      );
    });

    it('answers 409 when outcome is duplicate name conflict', async () => {
      const { controller, reply } = createMocks({
        createPayee: vi.fn().mockResolvedValue({
          kind: CATALOG_CREATE_OUTCOMES.CONFLICT,
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

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(409);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Payee with this name already exists in the workspace',
        }),
      );
    });

    it('answers with replayed status and body when outcome is replayed', async () => {
      const { controller, reply } = createMocks({
        createPayee: vi.fn().mockResolvedValue({
          kind: CATALOG_CREATE_OUTCOMES.REPLAYED,
          status: 201,
          etag: null,
          body: mockPayee,
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

      await controller.createPayee(request, reply);
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(mockPayee);
    });
  });

  describe('listPayees', () => {
    it('answers 400 when X-Workspace-Id header is missing', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: {},
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listPayees(request, reply);
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid X-Workspace-Id header',
        }),
      );
    });

    it('answers 400 when query parameters fail validation (e.g. invalid limit)', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listPayees(request, reply, undefined, '250');
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list payees query',
        }),
      );
    });

    it('answers 200 with paginated payee page on success', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listPayees(request, reply, undefined, '50');
      expect(reply.status).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith({
        items: [mockPayee],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    });

    it('answers 403 when outcome is forbidden', async () => {
      const { controller, reply } = createMocks({
        listPayees: vi.fn().mockResolvedValue({
          kind: CATALOG_LIST_OUTCOMES.FORBIDDEN,
        }),
      });
      const request = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listPayees(request, reply);
      expect(reply.status).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.FORBIDDEN,
        }),
      );
    });
  });
});
