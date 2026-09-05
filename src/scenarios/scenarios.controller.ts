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
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  SCENARIOS_PORT,
  SCENARIO_OUTCOMES,
  type ScenariosPort,
} from './scenario.port.js';
import {
  createScenarioCommand,
  ScenarioCommandValidationError,
} from './scenario-command.js';
import {
  createScenarioListQuery,
  ScenarioQueryValidationError,
} from './scenario-query.js';

@Controller('v1/scenarios')
@UseGuards(JwtAuthGuard)
export class ScenariosController {
  public constructor(
    @Inject(SCENARIOS_PORT) private readonly port: ScenariosPort,
  ) {}

  @Get()
  public async list(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok') {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    }

    let q;
    try {
      q = createScenarioListQuery({
        workspaceId: h.workspaceId,
        cursorParam: cursor,
        limitParam: limit,
      });
    } catch (e) {
      if (e instanceof ScenarioQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Scenario query validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.listScenarios(req.identity.subject, q);
    if (o.kind === SCENARIO_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    return reply.code(200).type('application/json').send(o.page);
  }

  @Post()
  public async create(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok') {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    }

    const k = validateIdempotencyKey(req.headers['idempotency-key']);
    if (k.kind !== 'ok') {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        detail: k.reason,
        status: 400,
      });
    }

    let command;
    try {
      command = createScenarioCommand(req.body);
    } catch (e) {
      if (e instanceof ScenarioCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Scenario validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.createScenario(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );

    if (o.kind === SCENARIO_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (o.kind === SCENARIO_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }

    if (o.kind === SCENARIO_OUTCOMES.REPLAYED) {
      return reply.code(o.status).type('application/json').send(o.body);
    }

    return reply.code(201).type('application/json').send(o.scenario);
  }
}
