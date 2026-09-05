import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';
import {
  SCENARIO_OUTCOMES,
  type Scenario,
  type ScenarioPage,
  type ScenariosPort,
} from '../../src/scenarios/scenario.port.js';
import { ScenariosController } from '../../src/scenarios/scenarios.controller.js';

describe('ScenariosController', () => {
  const subject = '11111111-0000-4000-8000-000000000001';
  const workspaceId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const idempotencyKey = 'bbbbbbbb-0000-4000-8000-000000000001';

  const validBody = {
    name: 'Growth Scenario',
    description: 'High growth',
    assumptions: [{ type: 'income_change', value: { amount: 100 } }],
  };

  const sampleScenario: Scenario = {
    id: 'cccccccc-0000-4000-8000-000000000001',
    name: validBody.name,
    description: validBody.description,
    assumptions: validBody.assumptions as unknown as Scenario['assumptions'],
    createdAt: '2026-09-04T12:00:00.000000Z',
    lastRunId: null,
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
      request: { id: 'req-1', url: '/v1/scenarios' },
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
    query?: Record<string, string | undefined>;
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
      query: options.query ?? {},
    } as unknown as AuthenticatedRequest;
  }

  function createMockPort(overrides?: Partial<ScenariosPort>): ScenariosPort {
    return {
      createScenario: vi.fn(),
      listScenarios: vi.fn(),
      runScenario: vi.fn(),
      ...overrides,
    };
  }

  describe('POST /v1/scenarios (create)', () => {
    it('returns 400 when X-Workspace-Id is missing or malformed', async () => {
      const mockPort = createMockPort();
      const controller = new ScenariosController(mockPort);

      for (const workspaceIdHeader of [undefined, '', 'not-a-uuid']) {
        const reply = createReplyMock();
        const req = createRequestMock({
          workspaceIdHeader,
          idempotencyKeyHeader: idempotencyKey,
          body: validBody,
        });

        await controller.create(req, reply);
        expect(reply.getStatus()).toBe(400);
      }
    });

    it('returns 400 when Idempotency-Key is missing or invalid', async () => {
      const mockPort = createMockPort();
      const controller = new ScenariosController(mockPort);

      for (const idempotencyKeyHeader of [undefined, '', 'not-a-uuid']) {
        const reply = createReplyMock();
        const req = createRequestMock({
          workspaceIdHeader: workspaceId,
          idempotencyKeyHeader,
          body: validBody,
        });

        await controller.create(req, reply);
        expect(reply.getStatus()).toBe(400);
      }
    });

    it('returns 422 when body validation fails', async () => {
      const mockPort = createMockPort();
      const controller = new ScenariosController(mockPort);

      const invalidBodies = [
        {}, // missing name and assumptions
        { ...validBody, name: '' }, // empty name
        { ...validBody, assumptions: [] }, // empty assumptions
        { ...validBody, assumptions: [{ type: 'unknown', value: {} }] }, // unknown type
      ];

      for (const body of invalidBodies) {
        const reply = createReplyMock();
        const req = createRequestMock({
          workspaceIdHeader: workspaceId,
          idempotencyKeyHeader: idempotencyKey,
          body,
        });

        await controller.create(req, reply);
        expect(reply.getStatus()).toBe(422);
      }
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const mockPort = createMockPort({
        createScenario: vi.fn().mockResolvedValueOnce({
          kind: SCENARIO_OUTCOMES.FORBIDDEN,
        }),
      });
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(403);
    });

    it('returns 409 when port returns CONFLICT', async () => {
      const mockPort = createMockPort({
        createScenario: vi.fn().mockResolvedValueOnce({
          kind: SCENARIO_OUTCOMES.CONFLICT,
        }),
      });
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(409);
    });

    it('returns 201 when port returns CREATED', async () => {
      const mockPort = createMockPort({
        createScenario: vi.fn().mockResolvedValueOnce({
          kind: SCENARIO_OUTCOMES.CREATED,
          scenario: sampleScenario,
        }),
      });
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(201);
      expect(reply.getPayload()).toEqual(sampleScenario);
    });

    it('returns original status and body when port returns REPLAYED', async () => {
      const mockPort = createMockPort({
        createScenario: vi.fn().mockResolvedValueOnce({
          kind: SCENARIO_OUTCOMES.REPLAYED,
          status: 201,
          body: sampleScenario,
        }),
      });
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        idempotencyKeyHeader: idempotencyKey,
        body: validBody,
      });

      await controller.create(req, reply);
      expect(reply.getStatus()).toBe(201);
      expect(reply.getPayload()).toEqual(sampleScenario);
    });
  });

  describe('GET /v1/scenarios (list)', () => {
    it('returns 400 when X-Workspace-Id is missing or malformed', async () => {
      const mockPort = createMockPort();
      const controller = new ScenariosController(mockPort);

      for (const workspaceIdHeader of [undefined, '', 'bad-uuid']) {
        const reply = createReplyMock();
        const req = createRequestMock({ workspaceIdHeader });

        await controller.list(req, reply);
        expect(reply.getStatus()).toBe(400);
      }
    });

    it('returns 422 when limit is invalid or out-of-range', async () => {
      const mockPort = createMockPort();
      const controller = new ScenariosController(mockPort);

      for (const limit of ['0', '201', 'abc', '-5']) {
        const reply = createReplyMock();
        const req = createRequestMock({
          workspaceIdHeader: workspaceId,
          query: { limit },
        });

        await controller.list(req, reply, undefined, limit);
        expect(reply.getStatus()).toBe(422);
      }
    });

    it('returns 422 when cursor is invalid', async () => {
      const mockPort = createMockPort();
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({
        workspaceIdHeader: workspaceId,
        query: { cursor: 'not-valid-base64!' },
      });

      await controller.list(req, reply, 'not-valid-base64!', undefined);
      expect(reply.getStatus()).toBe(422);
    });

    it('returns 403 when port returns FORBIDDEN', async () => {
      const mockPort = createMockPort({
        listScenarios: vi.fn().mockResolvedValueOnce({
          kind: SCENARIO_OUTCOMES.FORBIDDEN,
        }),
      });
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({ workspaceIdHeader: workspaceId });

      await controller.list(req, reply);
      expect(reply.getStatus()).toBe(403);
    });

    it('returns 200 with scenario page when authorized', async () => {
      const page: ScenarioPage = {
        items: [sampleScenario],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
      const mockPort = createMockPort({
        listScenarios: vi.fn().mockResolvedValueOnce({
          kind: 'ok',
          page,
        }),
      });
      const controller = new ScenariosController(mockPort);

      const reply = createReplyMock();
      const req = createRequestMock({ workspaceIdHeader: workspaceId });

      await controller.list(req, reply);
      expect(reply.getStatus()).toBe(200);
      expect(reply.getPayload()).toEqual(page);
    });
  });
});
