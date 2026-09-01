import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  JOB_READ_OUTCOMES,
  type JobsPort,
  type Job,
} from '../../src/jobs/job.port.js';
import { JobsController } from '../../src/jobs/jobs.controller.js';
import type { AuthenticatedRequest } from '../../src/platform/authenticated-request.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const JOB_ID = '00000000-0000-0000-0000-000000007001';

const MOCK_JOB: Job = {
  id: JOB_ID,
  type: 'import_commit',
  status: 'completed',
  progressPercent: 100,
  resultResourceId: '00000000-0000-0000-0000-000000007002',
  error: null,
  createdAt: '2026-08-31T12:00:00.000Z',
  startedAt: '2026-08-31T12:00:01.000Z',
  completedAt: '2026-08-31T12:00:05.000Z',
};

function createMocks() {
  const port: JobsPort = {
    getJob: vi.fn(),
  };

  const controller = new JobsController(port);

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
      url: `/v1/jobs/${JOB_ID}`,
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

describe('JobsController', () => {
  describe('GET /v1/jobs/:jobId', () => {
    it('answers 400 when X-Workspace-Id header is missing', async () => {
      const {
        controller,
        reply,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      await controller.getJob(JOB_ID, createRequest({}), reply);

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

      await controller.getJob(
        JOB_ID,
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

    it('answers 400 when jobId param is invalid', async () => {
      const {
        controller,
        reply,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      await controller.getJob(
        'not-a-valid-uuid',
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
      );

      expect(getSentStatus()).toBe(400);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 400,
          title: 'Invalid job identifier',
          errors: expect.arrayContaining([
            expect.objectContaining({
              field: 'jobId',
              code: 'invalid',
            }),
          ]),
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

      port.getJob = vi.fn().mockResolvedValue({
        kind: JOB_READ_OUTCOMES.FORBIDDEN,
      });

      await controller.getJob(
        JOB_ID,
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

    it('answers 404 when job is not found', async () => {
      const {
        controller,
        reply,
        port,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      port.getJob = vi.fn().mockResolvedValue({
        kind: JOB_READ_OUTCOMES.NOT_FOUND,
      });

      await controller.getJob(
        JOB_ID,
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
      );

      expect(getSentStatus()).toBe(404);
      expect(getSentPayload()).toEqual(
        expect.objectContaining({
          status: 404,
          title: 'Job not found',
        }),
      );
    });

    it('answers 200 with job when found', async () => {
      const {
        controller,
        reply,
        port,
        createRequest,
        getSentStatus,
        getSentPayload,
      } = createMocks();

      port.getJob = vi.fn().mockResolvedValue({
        kind: JOB_READ_OUTCOMES.FOUND,
        job: MOCK_JOB,
      });

      await controller.getJob(
        JOB_ID,
        createRequest({ 'x-workspace-id': WORKSPACE_ID }),
        reply,
      );

      expect(getSentStatus()).toBe(200);
      expect(getSentPayload()).toEqual(MOCK_JOB);
      expect(port.getJob).toHaveBeenCalledWith(SUBJECT, WORKSPACE_ID, JOB_ID);
    });
  });
});
