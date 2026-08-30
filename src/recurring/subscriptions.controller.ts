import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  RECURRING_RULES_PORT,
  SUBSCRIPTION_LIST_OUTCOMES,
  type RecurringRulesPort,
  type SubscriptionListQuery,
} from './recurring.port.js';
import {
  createSubscriptionListQuery,
  SubscriptionQueryValidationError,
} from './subscription-query.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  public constructor(
    @Inject(RECURRING_RULES_PORT)
    private readonly recurringPort: RecurringRulesPort,
  ) {}

  @Get()
  public async listSubscriptions(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
    @Query('status') statusParam?: string,
  ): Promise<void> {
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return;
    }

    let query: SubscriptionListQuery;
    try {
      query = createSubscriptionListQuery({
        workspaceId: header.workspaceId,
        ...(cursorParam === undefined ? {} : { cursorParam }),
        ...(limitParam === undefined ? {} : { limitParam }),
        ...(statusParam === undefined ? {} : { statusParam }),
      });
    } catch (error) {
      if (error instanceof SubscriptionQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list subscriptions query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.recurringPort.listSubscriptions(
      request.identity.subject,
      query,
    );

    if (outcome.kind === SUBSCRIPTION_LIST_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    void reply.status(200).send(outcome.page);
  }
}
