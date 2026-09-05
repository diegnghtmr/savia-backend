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
  REPORTS_PORT,
  REPORT_OUTCOMES,
  type ReportsPort,
} from './report.port.js';
import {
  createReportDefinitionCommand,
  ReportCommandValidationError,
} from './report-command.js';
import {
  createReportListQuery,
  ReportQueryValidationError,
} from './report-query.js';

@Controller('v1/report-definitions')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  public constructor(
    @Inject(REPORTS_PORT) private readonly port: ReportsPort,
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
      q = createReportListQuery({
        workspaceId: h.workspaceId,
        cursorParam: cursor,
        limitParam: limit,
      });
    } catch (e) {
      if (e instanceof ReportQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Report query validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.listReportDefinitions(req.identity.subject, q);
    if (o.kind === REPORT_OUTCOMES.FORBIDDEN) {
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
      command = createReportDefinitionCommand(req.body);
    } catch (e) {
      if (e instanceof ReportCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Report definition validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.createReportDefinition(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );

    if (o.kind === REPORT_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (o.kind === REPORT_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }

    if (o.kind === REPORT_OUTCOMES.REPLAYED) {
      return reply.code(o.status).type('application/json').send(o.body);
    }

    return reply.code(201).type('application/json').send(o.reportDefinition);
  }
}
