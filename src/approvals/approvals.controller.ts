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
  APPROVAL_OUTCOMES,
  APPROVALS_PORT,
  type ApprovalDecisionCommand,
  type ApprovalsPort,
} from './approval.port.js';
import {
  ApprovalCommandValidationError,
  createApprovalDecisionCommand,
} from './approval-command.js';
import {
  ApprovalQueryValidationError,
  validateApprovalId,
} from './approval-query.js';

@Controller('v1/approvals')
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  public constructor(
    @Inject(APPROVALS_PORT) private readonly port: ApprovalsPort,
  ) {}

  @Get(':approvalId')
  public async get(
    @Param('approvalId') approvalId: string,
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

    let validApprovalId: string;
    try {
      validApprovalId = validateApprovalId(approvalId);
    } catch (e) {
      if (e instanceof ApprovalQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid approval identifier',
          status: 400,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.getApproval(
      req.identity.subject,
      h.workspaceId,
      validApprovalId,
    );

    if (o.kind === APPROVAL_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (o.kind === APPROVAL_OUTCOMES.NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Approval not found',
        status: 404,
      });
    }

    return reply.code(200).type('application/json').send(o.approval);
  }

  @Post(':approvalId/confirm')
  public async confirm(
    @Param('approvalId') approvalId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.handleDecision(approvalId, req, reply, 'confirm');
  }

  @Post(':approvalId/reject')
  public async reject(
    @Param('approvalId') approvalId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.handleDecision(approvalId, req, reply, 'reject');
  }

  private async handleDecision(
    approvalId: string,
    req: AuthenticatedRequest,
    reply: FastifyReply,
    action: 'confirm' | 'reject',
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

    let validApprovalId: string;
    try {
      validApprovalId = validateApprovalId(approvalId);
    } catch (e) {
      if (e instanceof ApprovalQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid approval identifier',
          status: 400,
          errors: e.violations,
        });
      }
      throw e;
    }

    let command: ApprovalDecisionCommand;
    try {
      command = createApprovalDecisionCommand(req.body);
    } catch (e) {
      if (e instanceof ApprovalCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Approval decision validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o =
      action === 'confirm'
        ? await this.port.confirmApproval(
            req.identity.subject,
            h.workspaceId,
            validApprovalId,
            command,
            k.key,
          )
        : await this.port.rejectApproval(
            req.identity.subject,
            h.workspaceId,
            validApprovalId,
            command,
            k.key,
          );

    if (o.kind === APPROVAL_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (o.kind === APPROVAL_OUTCOMES.NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Approval not found',
        status: 404,
      });
    }

    if (o.kind === APPROVAL_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Approval decision conflict',
        detail: o.reason ?? 'Approval cannot be decided in its current state',
        status: 409,
      });
    }

    if (o.kind === APPROVAL_OUTCOMES.REPLAYED) {
      return reply.code(o.status).type('application/json').send(o.body);
    }

    return reply.code(200).type('application/json').send(o.approval);
  }
}
