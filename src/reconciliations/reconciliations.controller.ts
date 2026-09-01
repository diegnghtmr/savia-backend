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

import {
  RECONCILIATION_CREATE_OUTCOMES,
  RECONCILIATION_GET_OUTCOMES,
  RECONCILIATION_COMPLETE_OUTCOMES,
  RECONCILIATIONS_PORT,
  type CreateReconciliationCommand,
  type ReconciliationsPort,
} from './reconciliation.port.js';
import {
  createReconciliationCommand,
  completeReconciliationCommand,
  ReconciliationCommandValidationError,
} from './reconciliation-command.js';
import {
  validateReconciliationId,
  ReconciliationQueryValidationError,
} from './reconciliation-query.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/reconciliations')
@UseGuards(JwtAuthGuard)
export class ReconciliationsController {
  public constructor(
    @Inject(RECONCILIATIONS_PORT)
    private readonly reconciliationsPort: ReconciliationsPort,
  ) {}

  @Post()
  public async createReconciliation(
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

    let command: CreateReconciliationCommand;
    try {
      command = createReconciliationCommand(request.body);
    } catch (error) {
      if (error instanceof ReconciliationCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Reconciliation create validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.reconciliationsPort.createReconciliation(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (
      outcome.kind === RECONCILIATION_CREATE_OUTCOMES.OPEN_RECONCILIATION_EXISTS
    ) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Open reconciliation already exists',
        detail: 'An open reconciliation already exists for this account.',
        status: 409,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.ACCOUNT_UNRESOLVED,
        title: 'Account unresolved',
        detail: 'The specified account was not found in the workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.ACCOUNT_CLOSED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.ACCOUNT_CLOSED,
        title: 'Account is closed',
        detail: 'Reconciliations cannot be created for a closed account.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.CURRENCY_MISMATCH) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Currency mismatch',
        detail: 'Statement balance currency does not match account currency.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.FUTURE_STATEMENT_DATE) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Future statement date',
        detail: 'Statement date must not be in the future.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.AMOUNT_OUT_OF_RANGE) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Amount out of range',
        detail:
          'Computed balance or difference exceeds signed 64-bit integer range.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    void reply.status(201).send(outcome.reconciliation);
  }

  @Get(':reconciliationId')
  public async getReconciliation(
    @Param('reconciliationId') rawReconciliationId: string,
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

    let reconciliationId: string;
    try {
      reconciliationId = validateReconciliationId(rawReconciliationId);
    } catch (error) {
      if (error instanceof ReconciliationQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid reconciliation identifier',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.reconciliationsPort.getReconciliation(
      request.identity.subject,
      header.workspaceId,
      reconciliationId,
    );

    if (outcome.kind === RECONCILIATION_GET_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === RECONCILIATION_GET_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Reconciliation not found',
        status: 404,
      });
      return;
    }

    void reply.status(200).send(outcome.reconciliation);
  }

  @Post(':reconciliationId/complete')
  public async completeReconciliation(
    @Param('reconciliationId') rawReconciliationId: string,
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
    let reconciliationId: string;
    try {
      reconciliationId = validateReconciliationId(rawReconciliationId);
    } catch (error) {
      if (error instanceof ReconciliationQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid reconciliation identifier',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }
    let command;
    try {
      command = completeReconciliationCommand(request.body);
    } catch (error) {
      if (error instanceof ReconciliationCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Reconciliation completion validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }
    const outcome = await this.reconciliationsPort.completeReconciliation(
      request.identity.subject,
      header.workspaceId,
      reconciliationId,
      command,
      keyResult.key,
    );
    if (outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }
    if (outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Reconciliation not found',
        status: 404,
      });
      return;
    }
    if (outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.ALREADY_FINAL) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Reconciliation is already finalized',
        status: 409,
      });
      return;
    }
    if (
      outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.IDEMPOTENCY_CONFLICT
    ) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }
    if (outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.REPLAYED) {
      void reply.status(outcome.status).send(outcome.body);
      return;
    }
    if (
      outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.TRANSACTIONS_INVALID ||
      outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.ADJUSTMENT_INVALID ||
      outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.AMOUNT_OUT_OF_RANGE
    ) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Reconciliation completion validation failed',
        status: 422,
      });
      return;
    }
    if (outcome.kind === RECONCILIATION_COMPLETE_OUTCOMES.COMPLETED) {
      void reply.status(200).send(outcome.reconciliation);
    }
  }
}
