import { Controller, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { parseIfMatch } from '../platform/if-match.js';
import {
  PROBLEM_TYPES,
  sendProblem,
  type Problem,
} from '../platform/problem-details.js';
import { SessionJwtAuthGuard } from '../platform/session-jwt-auth.guard.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import type { SubscriptionDecision } from './recurring.port.js';
import { RecurringService } from './recurring.service.js';

const problems = {
  forbidden: {
    status: 403,
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'Workspace access forbidden',
  },
  idempotency_conflict: {
    status: 409,
    type: PROBLEM_TYPES.CONFLICT,
    title: 'Idempotency key reused with different payload',
  },
  not_found: {
    status: 404,
    type: PROBLEM_TYPES.NOT_FOUND,
    title: 'Subscription not found',
  },
  resolved: {
    status: 409,
    type: PROBLEM_TYPES.CONFLICT,
    title: 'Subscription is already resolved',
  },
  stale: {
    status: 412,
    type: PROBLEM_TYPES.PRECONDITION_FAILED,
    title: 'Subscription ETag does not match',
  },
  unprocessable: {
    status: 422,
    type: PROBLEM_TYPES.UNPROCESSABLE,
    title: 'Candidate cannot create a recurring rule',
  },
} satisfies Record<string, Problem>;

@Controller('v1/subscriptions')
@UseGuards(SessionJwtAuthGuard)
export class SubscriptionDecisionsController {
  public constructor(private readonly recurringService: RecurringService) {}

  @Post(':subscriptionId/confirm')
  public confirm(
    @Param('subscriptionId') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.decide('confirm', id, req, reply);
  }

  @Post(':subscriptionId/discard')
  public discard(
    @Param('subscriptionId') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.decide('discard', id, req, reply);
  }

  private async decide(
    action: SubscriptionDecision,
    id: string,
    req: AuthenticatedRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const workspace = parseWorkspaceHeader(req.headers['x-workspace-id']);
    const badRequest = (title: string, detail?: string) =>
      sendProblem(reply, {
        status: 400,
        type: PROBLEM_TYPES.BAD_REQUEST,
        title,
        ...(detail ? { detail } : {}),
      });
    if (workspace.kind !== 'ok') {
      return badRequest('Invalid X-Workspace-Id header');
    }
    if (!UUID_PATTERN.test(id)) return badRequest('Invalid subscriptionId');
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (key.kind !== 'ok') {
      return badRequest('Invalid Idempotency-Key header', key.reason);
    }
    const header = parseIfMatch(req.headers['if-match']);
    if (header.kind === 'malformed') {
      return badRequest('Malformed If-Match header');
    }
    const outcome = await this.recurringService.decideSubscription(
      req.identity.subject,
      {
        action,
        workspaceId: workspace.workspaceId,
        subscriptionId: id.toLowerCase(),
        idempotencyKey: key.key.toLowerCase(),
        ...(header.kind === 'versions'
          ? { ifMatch: [...new Set(header.versions)].sort((a, b) => a - b) }
          : header.kind === 'any'
            ? { ifMatch: '*' }
            : {}),
      },
    );
    if (outcome.kind !== 'ok') {
      return sendProblem(reply, problems[outcome.kind]);
    }
    void reply.status(200).header('etag', outcome.etag).send(outcome.body);
  }
}
