import {
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  RECURRING_CREATE_OUTCOMES,
  RECURRING_LIST_OUTCOMES,
  RECURRING_RULES_PORT,
  type CreateRecurringRuleCommand,
  type RecurringRuleListQuery,
  type RecurringRulesPort,
} from './recurring.port.js';
import {
  createRecurringRuleCommand,
  RecurringCommandValidationError,
} from './recurring-command.js';
import {
  createRecurringRuleListQuery,
  RecurringQueryValidationError,
} from './recurring-query.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/recurring-rules')
@UseGuards(JwtAuthGuard)
export class RecurringRulesController {
  public constructor(
    @Inject(RECURRING_RULES_PORT)
    private readonly recurringPort: RecurringRulesPort,
  ) {}

  @Post()
  public async createRecurringRule(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
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

    const keyResult = validateIdempotencyKey(
      request.headers['idempotency-key'],
    );
    if (keyResult.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        detail: keyResult.reason,
        status: 400,
      });
      return;
    }

    let command: CreateRecurringRuleCommand;
    try {
      command = createRecurringRuleCommand(request.body);
    } catch (error) {
      if (error instanceof RecurringCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Recurring rule validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.recurringPort.createRecurringRule(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Account not found',
        detail:
          'The specified account in template was not found in this workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.CATEGORY_NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Category not found',
        detail:
          'The specified category in template was not found in this workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.PAYEE_NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Payee not found',
        detail:
          'The specified payee in template was not found in this workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.TAG_NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Tag not found',
        detail:
          'One or more tags in template were not found in this workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECURRING_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    void reply.status(201).send(outcome.rule);
  }

  @Get()
  public async listRecurringRules(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
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

    let query: RecurringRuleListQuery;
    try {
      query = createRecurringRuleListQuery({
        workspaceId: header.workspaceId,
        ...(cursorParam === undefined ? {} : { cursorParam }),
        ...(limitParam === undefined ? {} : { limitParam }),
      });
    } catch (error) {
      if (error instanceof RecurringQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list recurring rules query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.recurringPort.listRecurringRules(
      request.identity.subject,
      query,
    );

    if (outcome.kind === RECURRING_LIST_OUTCOMES.FORBIDDEN) {
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
