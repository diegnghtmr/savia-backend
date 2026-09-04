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
import { DEBTS_PORT, DEBT_OUTCOMES, type DebtsPort } from './debt.port.js';
import {
  createDebtCommand,
  createDebtPaymentCommand,
  DebtCommandValidationError,
} from './debt-command.js';
import {
  createDebtListQuery,
  validateDebtId,
  DebtQueryValidationError,
} from './debt-query.js';

@Controller('v1/debts')
@UseGuards(JwtAuthGuard)
export class DebtsController {
  public constructor(@Inject(DEBTS_PORT) private readonly port: DebtsPort) {}

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
      q = createDebtListQuery({
        workspaceId: h.workspaceId,
        cursorParam: cursor,
        limitParam: limit,
      });
    } catch (e) {
      if (e instanceof DebtQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid debt list query',
          status: 400,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.listDebts(req.identity.subject, q);
    if (o.kind === DEBT_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    void reply.status(200).send(o.page);
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
      command = createDebtCommand(req.body);
    } catch (e) {
      if (e instanceof DebtCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Debt validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.createDebt(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );

    if (o.kind === DEBT_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }
    if (o.kind === DEBT_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }
    if (o.kind === DEBT_OUTCOMES.REPLAYED) {
      return void reply.status(o.status).send(o.body);
    }
    if (o.kind !== DEBT_OUTCOMES.CREATED) return;
    void reply.status(201).send(o.debt);
  }

  @Post(':debtId/payments')
  public async createPayment(
    @Param('debtId') rawDebtId: string,
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

    let debtId: string;
    try {
      debtId = validateDebtId(rawDebtId);
    } catch (e) {
      if (e instanceof DebtQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid debt identifier',
          status: 400,
          errors: e.violations,
        });
      }
      throw e;
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
      command = createDebtPaymentCommand(req.body);
    } catch (e) {
      if (e instanceof DebtCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Debt payment validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.createDebtPayment(
      req.identity.subject,
      h.workspaceId,
      debtId,
      command,
      k.key,
    );

    if (o.kind === DEBT_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }
    if (o.kind === DEBT_OUTCOMES.NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Debt not found',
        status: 404,
      });
    }
    if (o.kind === DEBT_OUTCOMES.CURRENCY_MISMATCH) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Debt payment validation failed',
        status: 422,
        errors: [
          {
            field: 'totalAmount.currency',
            code: 'invalid',
            message: 'Payment currency must match debt currency',
          },
        ],
      });
    }
    if (o.kind === DEBT_OUTCOMES.ACCOUNT_NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Account not found',
        status: 422,
        errors: [
          {
            field: 'accountId',
            code: 'not-found',
            message: 'Account not found in workspace',
          },
        ],
      });
    }
    if (o.kind === DEBT_OUTCOMES.ACCOUNT_CLOSED) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Account is closed',
        status: 422,
        errors: [
          {
            field: 'accountId',
            code: 'closed',
            message: 'Cannot pay debt from closed account',
          },
        ],
      });
    }
    if (o.kind === DEBT_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Account currency mismatch',
        status: 422,
        errors: [
          {
            field: 'accountId',
            code: 'currency-mismatch',
            message: 'Payment currency must match account currency',
          },
        ],
      });
    }
    if (o.kind === DEBT_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }
    if (o.kind === DEBT_OUTCOMES.REPLAYED) {
      return void reply.status(o.status).send(o.body);
    }
    if (o.kind !== DEBT_OUTCOMES.CREATED) return;
    void reply.status(201).send(o.transaction);
  }
}
