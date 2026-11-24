import {
  Controller,
  Get,
  Put,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { parseIfMatch } from '../platform/if-match.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { parseDashboardPreferences } from './dashboard-preferences-command.js';
import { DashboardPreferencesService } from './dashboard-preferences.service.js';
import { SessionOnlyProblemFilter } from './session-only-problem.filter.js';

const problems = {
  forbidden: {
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'Workspace access forbidden',
    status: 403,
  },
  stale: {
    type: PROBLEM_TYPES.PRECONDITION_FAILED,
    title: 'Precondition failed',
    status: 412,
  },
  conflict: {
    type: PROBLEM_TYPES.CONFLICT,
    title: 'Idempotency key reused with different payload',
    status: 409,
  },
} as const;

@Controller('v1/me/dashboard-preferences')
@UseGuards(JwtAuthGuard)
@UseFilters(SessionOnlyProblemFilter)
export class DashboardPreferencesController {
  public constructor(
    private readonly preferences: DashboardPreferencesService,
  ) {}

  @Get()
  public async get(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspaceId = workspace(request, reply);
    if (!workspaceId) return;
    const outcome = await this.preferences.get(
      request.identity.subject,
      workspaceId,
    );
    if (outcome.kind === 'ok')
      void reply.header('etag', outcome.etag).status(200).send(outcome.body);
    else sendProblem(reply, problems[outcome.kind]);
  }

  @Put()
  public async put(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspaceId = workspace(request, reply);
    if (!workspaceId) return;
    const key = validateIdempotencyKey(request.headers['idempotency-key']);
    if (key.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        detail: key.reason,
        status: 400,
      });
      return;
    }
    const match = parseIfMatch(request.headers['if-match']);
    const version =
      match.kind === 'versions' && match.versions.length === 1
        ? match.versions[0]
        : undefined;
    if (!version) {
      sendProblem(reply, problems.stale);
      return;
    }
    const command = parseDashboardPreferences(request.body);
    if (!command) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Invalid dashboard preferences',
        status: 422,
      });
      return;
    }
    const outcome = await this.preferences.put(
      request.identity.subject,
      workspaceId,
      command,
      version,
      key.key,
    );
    if (outcome.kind === 'ok')
      void reply.header('etag', outcome.etag).status(200).send(outcome.body);
    else sendProblem(reply, problems[outcome.kind]);
  }
}

function workspace(
  request: AuthenticatedRequest,
  reply: FastifyReply,
): string | undefined {
  const parsed = parseWorkspaceHeader(request.headers['x-workspace-id']);
  if (parsed.kind === 'ok') return parsed.workspaceId;
  sendProblem(reply, {
    type: PROBLEM_TYPES.BAD_REQUEST,
    title: 'Invalid X-Workspace-Id header',
    status: 400,
  });
  return undefined;
}
