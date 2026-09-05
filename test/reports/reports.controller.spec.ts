import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  REPORT_OUTCOMES,
  type ReportDefinition,
  type ReportsPort,
} from '../../src/reports/report.port.js';
import { ReportsController } from '../../src/reports/reports.controller.js';

describe('ReportsController', () => {
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const subject = '11111111-0000-4000-8000-000000000001';
  const idempotencyKey = 'bbbbbbbb-0000-4000-8000-000000000001';

  const sampleDefinition: ReportDefinition = {
    id: 'dddddddd-0000-4000-8000-000000000001',
    name: 'Sales',
    dimensions: ['month'],
    measures: ['sum'],
    visualization: 'bar',
    filters: {},
    version: 1,
  };

  function createPortMock(): ReportsPort {
    return {
      createReportDefinition: vi.fn().mockResolvedValue({
        kind: REPORT_OUTCOMES.CREATED,
        reportDefinition: sampleDefinition,
      }),
      listReportDefinitions: vi.fn().mockResolvedValue({
        kind: 'ok',
        page: {
          items: [sampleDefinition],
          pageInfo: { hasNextPage: false, nextCursor: null },
        },
      }),
    };
  }

  function createReplyMock() {
    let sentStatus = 200;
    let sentPayload: unknown = undefined;
    const sentHeaders: Record<string, string> = {};

    const reply = {
      code: vi.fn((c: number) => {
        sentStatus = c;
        return reply;
      }),
      status: vi.fn((s: number) => {
        sentStatus = s;
        return reply;
      }),
      type: vi.fn((t: string) => {
        sentHeaders['content-type'] = t;
        return reply;
      }),
      header: vi.fn((name: string, val: string) => {
        sentHeaders[name] = val;
        return reply;
      }),
      send: vi.fn((p: unknown) => {
        sentPayload = p;
        return reply;
      }),
      request: { id: 'req-1', url: '/v1/report-definitions' },
      getStatus: () => sentStatus,
      getPayload: () => sentPayload,
    };
    return reply as unknown as FastifyReply & {
      getStatus: () => number;
      getPayload: () => unknown;
    };
  }

  describe('list', () => {
    it('returns 400 when X-Workspace-Id header is missing or invalid', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: {},
        identity: { subject },
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.list(req, reply);
      expect(reply.getStatus()).toBe(400);
    });

    it('returns 422 when query parameters are invalid', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.list(req, reply, 'bad-cursor', 'not-a-number');
      expect(reply.getStatus()).toBe(422);
    });

    it('returns 403 when port returns forbidden', async () => {
      const port = createPortMock();
      vi.mocked(port.listReportDefinitions).mockResolvedValue({
        kind: REPORT_OUTCOMES.FORBIDDEN,
      });
      const controller = new ReportsController(port);
      const req = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.list(req, reply);
      expect(reply.getStatus()).toBe(403);
    });

    it('returns 200 with page JSON when successful', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.list(req, reply);
      expect(reply.getStatus()).toBe(200);
      expect(reply.send).toHaveBeenCalledWith({
        items: [sampleDefinition],
        pageInfo: { hasNextPage: false, nextCursor: null },
      });
    });
  });

  describe('create', () => {
    const validBody = {
      name: 'Sales',
      dimensions: ['month'],
      measures: ['sum'],
      visualization: 'bar',
    };

    it('returns 400 when X-Workspace-Id header is missing', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: { 'idempotency-key': idempotencyKey },
        identity: { subject },
        body: validBody,
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(400);
    });

    it('returns 400 when Idempotency-Key header is missing or invalid', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: { 'x-workspace-id': workspaceId },
        identity: { subject },
        body: validBody,
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(400);
    });

    it('returns 422 when body validation fails', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        identity: { subject },
        body: { ...validBody, measures: [] }, // empty measures
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(422);
    });

    it('returns 403 when port returns forbidden', async () => {
      const port = createPortMock();
      vi.mocked(port.createReportDefinition).mockResolvedValue({
        kind: REPORT_OUTCOMES.FORBIDDEN,
      });
      const controller = new ReportsController(port);
      const req = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        identity: { subject },
        body: validBody,
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(403);
    });

    it('returns 409 when port returns conflict', async () => {
      const port = createPortMock();
      vi.mocked(port.createReportDefinition).mockResolvedValue({
        kind: REPORT_OUTCOMES.CONFLICT,
      });
      const controller = new ReportsController(port);
      const req = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        identity: { subject },
        body: validBody,
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(409);
    });

    it('returns replayed status and payload when port returns replayed', async () => {
      const port = createPortMock();
      vi.mocked(port.createReportDefinition).mockResolvedValue({
        kind: REPORT_OUTCOMES.REPLAYED,
        status: 201,
        etag: null,
        body: sampleDefinition,
      });
      const controller = new ReportsController(port);
      const req = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        identity: { subject },
        body: validBody,
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(201);
      expect(reply.send).toHaveBeenCalledWith(sampleDefinition);
    });

    it('returns 201 when created successfully', async () => {
      const port = createPortMock();
      const controller = new ReportsController(port);
      const req = {
        headers: {
          'x-workspace-id': workspaceId,
          'idempotency-key': idempotencyKey,
        },
        identity: { subject },
        body: validBody,
      } as unknown as AuthenticatedRequest;
      const reply = createReplyMock();

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(201);
      expect(reply.send).toHaveBeenCalledWith(sampleDefinition);
    });
  });
});
