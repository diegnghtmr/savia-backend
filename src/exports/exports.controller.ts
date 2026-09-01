import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
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
  createExportCommand,
  ExportCommandValidationError,
} from './export-command.js';
import {
  validateExportJobId,
  ExportQueryValidationError,
} from './export-query.js';
import {
  EXPORT_OUTCOMES,
  EXPORTS_PORT,
  type ExportsPort,
} from './export.port.js';
@Controller('v1/export-jobs')
@UseGuards(JwtAuthGuard)
export class ExportsController {
  public constructor(
    @Inject(EXPORTS_PORT) private readonly port: ExportsPort,
  ) {}
  @Post() public async create(
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
      command = createExportCommand(req.body);
    } catch (e) {
      if (e instanceof ExportCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Export validation failed',
          status: 422,
          errors: e.violations,
        });
      throw e;
    }
    const outcome = await this.port.createExportJob(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );
    if (outcome.kind === EXPORT_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === EXPORT_OUTCOMES.IDEMPOTENCY_CONFLICT)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    if (outcome.kind === EXPORT_OUTCOMES.UNSUPPORTED_RESOURCE)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Export resource unavailable',
        detail:
          'This resource is declared by the contract but is not yet available.',
        status: 422,
      });
    if (outcome.kind === EXPORT_OUTCOMES.UNREPRESENTABLE)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Export value cannot be represented',
        detail: outcome.detail,
        status: 422,
      });
    if (outcome.kind === EXPORT_OUTCOMES.REPLAYED)
      return void reply.status(outcome.status).send(outcome.body);
    void reply.status(202).send(outcome.job);
  }
  @Get(':exportJobId') public async get(
    @Param('exportJobId') raw: string,
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
    let id;
    try {
      id = validateExportJobId(raw);
    } catch (e) {
      if (e instanceof ExportQueryValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid export job identifier',
          status: 400,
          errors: e.violations,
        });
      throw e;
    }
    const outcome = await this.port.getExportJob(
      req.identity.subject,
      h.workspaceId,
      id,
    );
    if (outcome.kind === 'forbidden')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (outcome.kind === 'not-found')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Export job not found',
        status: 404,
      });
    void reply.status(200).send(outcome.job);
  }
}
