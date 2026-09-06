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
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  REPORTS_PORT,
  REPORT_OUTCOMES,
  REPORT_RUN_OUTCOMES,
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
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  createReportRunCommand,
  ReportRunCommandValidationError,
} from './report-run-command.js';

@Controller('v1')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  public constructor(
    @Inject(REPORTS_PORT) private readonly port: ReportsPort,
  ) {}

  @Get('report-definitions')
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

  @Post('report-definitions')
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

  @Post('report-runs')
  public async createRun(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    const k = validateIdempotencyKey(req.headers['idempotency-key']);
    if (k.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        detail: k.reason,
        status: 400,
      });
    let command;
    try {
      command = createReportRunCommand(req.body);
    } catch (error) {
      if (error instanceof ReportRunCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Report run validation failed',
          status: 422,
          errors: error.violations,
        });
      throw error;
    }
    const outcome = await this.port.createReportRun!(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );
    if (outcome.kind === REPORT_RUN_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === REPORT_RUN_OUTCOMES.CONFLICT)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    if (outcome.kind === REPORT_RUN_OUTCOMES.REPLAYED)
      return reply
        .code(outcome.status)
        .type('application/json')
        .send(outcome.body);
    if (outcome.kind === REPORT_RUN_OUTCOMES.MISSING_RATE)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Missing exchange rate',
        detail: `Missing exchange rate from ${outcome.fromCurrency} to ${outcome.toCurrency}`,
        status: 422,
      });
    if (outcome.kind === REPORT_RUN_OUTCOMES.UNPROCESSABLE)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Report run request unprocessable',
        status: 422,
        errors: outcome.violations.map((v) => ({
          field: v.field,
          code: 'invalid',
          message: v.message,
        })),
      });
    return reply.code(202).type('application/json').send(outcome.reportRun);
  }

  @Get('report-runs/:reportRunId')
  public async getRun(
    @Param('reportRunId') reportRunId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    if (!UUID_PATTERN.test(reportRunId))
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid report run identifier',
        status: 400,
      });
    const outcome = await this.port.getReportRun!(
      req.identity.subject,
      h.workspaceId,
      reportRunId,
    );
    if (outcome.kind === REPORT_RUN_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === REPORT_RUN_OUTCOMES.NOT_FOUND)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Report run not found',
        status: 404,
      });
    return reply.code(200).type('application/json').send(outcome.reportRun);
  }
}
