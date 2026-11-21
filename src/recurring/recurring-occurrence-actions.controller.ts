import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { parseIfMatch } from '../platform/if-match.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseListQuery } from '../platform/list-query.js';
import {
  PROBLEM_TYPES,
  sendProblem,
  type Problem,
} from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import {
  OCCURRENCE_STATUSES,
  type OccurrenceStatus,
} from './postgres-occurrence-actions.adapter.js';
import {
  occurrenceFilter,
  RecurringOccurrenceActionsService,
  type ActionOutcome,
  type OccurrenceAction,
  type RuleTarget,
} from './recurring-occurrence-actions.service.js';

const problems = {
  forbidden: {
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'Workspace access forbidden',
    status: 403,
  },
  notFound: {
    type: PROBLEM_TYPES.NOT_FOUND,
    title: 'Recurring resource not found',
    status: 404,
  },
  state: {
    type: PROBLEM_TYPES.CONFLICT,
    title: 'Recurring occurrence state conflict',
    status: 409,
  },
  idempotency: {
    type: PROBLEM_TYPES.CONFLICT,
    title: 'Idempotency key reused with different payload',
    status: 409,
  },
  precondition: {
    type: PROBLEM_TYPES.PRECONDITION_FAILED,
    title: 'Recurring occurrence version mismatch',
    status: 412,
  },
  invalid: {
    type: PROBLEM_TYPES.UNPROCESSABLE,
    title: 'Recurring occurrence booking failed',
    status: 422,
  },
} as const satisfies Record<Exclude<ActionOutcome['kind'], 'ok'>, Problem>;

function respond(reply: FastifyReply, result: ActionOutcome): void {
  if (result.kind !== 'ok') return sendProblem(reply, problems[result.kind]);
  if (result.etag !== null) void reply.header('etag', result.etag);
  void reply.status(result.status).send(result.body);
}

function badRequest(reply: FastifyReply, title: string, detail?: string): void {
  sendProblem(reply, {
    type: PROBLEM_TYPES.BAD_REQUEST,
    title,
    status: 400,
    ...(detail !== undefined && { detail }),
  });
}

function parseRule(
  request: AuthenticatedRequest,
  reply: FastifyReply,
  ruleId: string,
): RuleTarget | undefined {
  const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
  if (header.kind !== 'ok') {
    badRequest(reply, 'Invalid X-Workspace-Id header');
    return undefined;
  }
  if (!UUID_PATTERN.test(ruleId)) {
    badRequest(reply, 'Invalid recurring rule ID');
    return undefined;
  }
  return { workspaceId: header.workspaceId, ruleId: ruleId.toLowerCase() };
}

@Controller('v1/recurring-rules/:ruleId/occurrences')
@UseGuards(JwtAuthGuard)
export class RecurringOccurrenceActionsController {
  public constructor(
    @Inject(RecurringOccurrenceActionsService)
    private readonly service: RecurringOccurrenceActionsService,
  ) {}

  @Get()
  public async list(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Param('ruleId') ruleId: string,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
    @Query('status') statusParam?: string,
  ): Promise<void> {
    const target = parseRule(request, reply, ruleId);
    if (!target) return;
    const status = statusParam as OccurrenceStatus | undefined;
    const valid = status === undefined || OCCURRENCE_STATUSES.includes(status);
    const filter = occurrenceFilter(target.ruleId, valid ? status : undefined);
    const { limit, cursor, violations } = parseListQuery({
      cursorParam,
      limitParam,
      expectedWorkspaceId: target.workspaceId,
      expectedFilter: filter,
    });
    const repeatedLimit =
      limitParam !== undefined && typeof limitParam !== 'string';
    if (!valid || violations.length !== 0 || repeatedLimit) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid recurring occurrence query',
        status: 400,
        errors: [
          ...violations,
          ...(valid
            ? []
            : [
                {
                  field: 'status',
                  code: 'invalid',
                  message: 'status must be a recurring occurrence status.',
                },
              ]),
        ],
      });
      return;
    }
    const result = await this.service.list(request.identity.subject, {
      ...target,
      limit,
      ...(cursor && { cursor }),
      ...(status && { status }),
    });
    respond(reply, result);
  }

  @Post(':occurrenceId/confirm')
  public confirm(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Param('ruleId') ruleId: string,
    @Param('occurrenceId') occurrenceId: string,
  ): Promise<void> {
    return this.run(request, reply, ruleId, occurrenceId, 'confirm');
  }

  @Post(':occurrenceId/skip')
  public skip(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Param('ruleId') ruleId: string,
    @Param('occurrenceId') occurrenceId: string,
  ): Promise<void> {
    return this.run(request, reply, ruleId, occurrenceId, 'skip');
  }

  private async run(
    request: AuthenticatedRequest,
    reply: FastifyReply,
    ruleId: string,
    occurrenceId: string,
    action: OccurrenceAction,
  ): Promise<void> {
    const target = parseRule(request, reply, ruleId);
    if (!target) return;
    if (!UUID_PATTERN.test(occurrenceId))
      return badRequest(reply, 'Invalid recurring occurrence ID');
    const key = validateIdempotencyKey(request.headers['idempotency-key']);
    if (key.kind !== 'ok')
      return badRequest(reply, 'Invalid Idempotency-Key header', key.reason);
    const ifMatch = parseIfMatch(request.headers['if-match']);
    if (ifMatch.kind === 'malformed')
      return badRequest(reply, 'Invalid If-Match header');
    const result = await this.service.run(request.identity.subject, {
      ...target,
      occurrenceId: occurrenceId.toLowerCase(),
      action,
      key: key.key,
      ifMatch,
    });
    respond(reply, result);
  }
}
