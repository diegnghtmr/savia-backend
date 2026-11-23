import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { parseBulkTransactionCommand } from './bulk-transaction-command.js';
import { BulkTransactionService } from './bulk-transaction.service.js';

const errors = {
  forbidden: {
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'Workspace access forbidden',
    status: 403,
  },
  conflict: {
    type: PROBLEM_TYPES.CONFLICT,
    title: 'Idempotency key reused with different payload',
    status: 409,
  },
  'not-found': {
    type: PROBLEM_TYPES.NOT_FOUND,
    title: 'Transaction not found',
    status: 404,
  },
  stale: {
    type: PROBLEM_TYPES.PRECONDITION_FAILED,
    title: 'Transaction version mismatch',
    status: 412,
  },
  ineligible: {
    type: PROBLEM_TYPES.UNPROCESSABLE,
    title: 'Ineligible transaction or action',
    status: 422,
  },
} as const;

@Controller('v1/transactions/bulk')
@UseGuards(JwtAuthGuard)
export class BulkTransactionController {
  public constructor(private readonly bulk: BulkTransactionService) {}

  @Post()
  public async update(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (workspace.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return;
    }
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
    const command = parseBulkTransactionCommand(request.body);
    if (!command) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Invalid bulk transaction request',
        status: 422,
      });
      return;
    }
    const outcome = await this.bulk.execute(
      request.identity.subject,
      workspace.workspaceId,
      command,
      key.key,
    );
    if (outcome.kind === 'ok') void reply.status(200).send(outcome.body);
    else sendProblem(reply, errors[outcome.kind]);
  }
}
