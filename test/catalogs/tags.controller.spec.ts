import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import { TagsController } from '../../src/catalogs/tags.controller.js';
import {
  CATALOG_CREATE_OUTCOMES,
  CATALOG_LIST_OUTCOMES,
  type CatalogsPort,
  type Tag,
} from '../../src/catalogs/catalogs.port.js';
import { PROBLEM_TYPES } from '../../src/platform/problem-details.js';

describe('TagsController', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

  const mockTag: Tag = {
    id: '00000000-0000-0000-0000-000000001001',
    name: 'Groceries',
    archived: false,
  };

  const validBody = {
    name: 'Groceries',
  };

  function createMocks(catalogsPortOverrides: Partial<CatalogsPort> = {}) {
    const fakeCatalogsPort: CatalogsPort = {
      createTag: vi.fn().mockResolvedValue({
        kind: CATALOG_CREATE_OUTCOMES.CREATED,
        tag: mockTag,
      }),
      listTags: vi.fn().mockResolvedValue({
        kind: CATALOG_LIST_OUTCOMES.OK,
        page: {
          items: [mockTag],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
      createPayee: vi.fn(),
      listPayees: vi.fn(),
      ...catalogsPortOverrides,
    };

    const controller = new TagsController(fakeCatalogsPort);

    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      request: {
        id: 'trace-123',
        url: '/v1/tags',
      },
    } as unknown as FastifyReply;

    return { controller, fakeCatalogsPort, reply };
  }

  describe('createTag', () => {
    it('answers 400 when X-Workspace-Id header is missing or malformed', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: { 'idempotency-key': idempotencyKey },
        body: validBody,
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.createTag(request, reply);
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

      await controller.createTag(request, reply);
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

      await controller.createTag(request, reply);
      expect(reply.status).toHaveBeenCalledWith(422);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Tag create validation failed',
        }),
      );
    });

    it('answers 201 with tag when created successfully', async () => {
      const { controller, reply, fakeCatalogsPort } = createMocks();
      const request = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        body: validBody,
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.createTag(request, reply);
      expect(fakeCatalogsPort.createTag).toHaveBeenCalledWith(
        subject,
        workspaceId,
        validBody,
        idempotencyKey,
      );
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(mockTag);
    });

    it('answers 403 when outcome is forbidden', async () => {
      const { controller, reply } = createMocks({
        createTag: vi.fn().mockResolvedValue({
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

      await controller.createTag(request, reply);
      expect(reply.status).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.FORBIDDEN,
        }),
      );
    });

    it('answers 409 when outcome is idempotency conflict', async () => {
      const { controller, reply } = createMocks({
        createTag: vi.fn().mockResolvedValue({
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

      await controller.createTag(request, reply);
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
        createTag: vi.fn().mockResolvedValue({
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

      await controller.createTag(request, reply);
      expect(reply.status).toHaveBeenCalledWith(409);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Tag with this name already exists in the workspace',
        }),
      );
    });

    it('answers with replayed status and body when outcome is replayed', async () => {
      const { controller, reply } = createMocks({
        createTag: vi.fn().mockResolvedValue({
          kind: CATALOG_CREATE_OUTCOMES.REPLAYED,
          status: 201,
          etag: null,
          body: mockTag,
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

      await controller.createTag(request, reply);
      expect(reply.status).toHaveBeenCalledWith(201);
      expect(reply.send).toHaveBeenCalledWith(mockTag);
    });
  });

  describe('listTags', () => {
    it('answers 400 when X-Workspace-Id header is missing', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: {},
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listTags(request, reply);
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

      await controller.listTags(request, reply, undefined, 'not-a-number');
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list tags query',
        }),
      );
    });

    it('answers 200 with paginated tag page on success', async () => {
      const { controller, reply } = createMocks();
      const request = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listTags(request, reply, undefined, '50');
      expect(reply.status).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith({
        items: [mockTag],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    });

    it('answers 403 when outcome is forbidden', async () => {
      const { controller, reply } = createMocks({
        listTags: vi.fn().mockResolvedValue({
          kind: CATALOG_LIST_OUTCOMES.FORBIDDEN,
        }),
      });
      const request = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;

      await controller.listTags(request, reply);
      expect(reply.status).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROBLEM_TYPES.FORBIDDEN,
        }),
      );
    });
  });
});
