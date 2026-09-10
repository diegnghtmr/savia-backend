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
import { FUNDS_PORT, FUND_OUTCOMES, type FundsPort } from './fund.port.js';
import {
  createFundCommand,
  createFundContributionCommand,
  FundCommandValidationError,
} from './fund-command.js';
import {
  createFundListQuery,
  validateFundId,
  FundQueryValidationError,
} from './fund-query.js';

@Controller('v1/funds')
@UseGuards(JwtAuthGuard)
export class FundsController {
  public constructor(@Inject(FUNDS_PORT) private readonly port: FundsPort) {}

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
      q = createFundListQuery({
        workspaceId: h.workspaceId,
        cursorParam: cursor,
        limitParam: limit,
      });
    } catch (e) {
      if (e instanceof FundQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid fund list query',
          status: 400,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.listFunds(req.identity.subject, q);
    if (o.kind === FUND_OUTCOMES.FORBIDDEN) {
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
      command = createFundCommand(req.body);
    } catch (e) {
      if (e instanceof FundCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Fund validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.createFund(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );

    if (o.kind === FUND_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }
    if (o.kind === FUND_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }
    if (o.kind === FUND_OUTCOMES.LINKED_ACCOUNT_NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Fund validation failed',
        status: 422,
        errors: [
          {
            field: 'linkedAccountId',
            code: 'not-found',
            message: 'linkedAccountId not found in workspace',
          },
        ],
      });
    }
    if (o.kind === FUND_OUTCOMES.REPLAYED) {
      return void reply.status(o.status).send(o.body);
    }
    if (o.kind !== FUND_OUTCOMES.CREATED) return;
    void reply.status(201).send(o.fund);
  }

  @Post(':fundId/contributions')
  public async contribute(
    @Param('fundId') rawFundId: string,
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

    let fundId: string;
    try {
      fundId = validateFundId(rawFundId);
    } catch (e) {
      if (e instanceof FundQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid fund identifier',
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
      command = createFundContributionCommand(req.body);
    } catch (e) {
      if (e instanceof FundCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Fund contribution validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.contributeToFund(
      req.identity.subject,
      h.workspaceId,
      fundId,
      command,
      k.key,
    );

    if (o.kind === FUND_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }
    if (o.kind === FUND_OUTCOMES.NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Fund not found',
        status: 404,
      });
    }
    if (o.kind === FUND_OUTCOMES.CURRENCY_MISMATCH) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Fund contribution validation failed',
        status: 422,
        errors: [
          {
            field: 'amount.currency',
            code: 'invalid',
            message: 'Contribution currency must match fund currency',
          },
        ],
      });
    }
    if (o.kind === FUND_OUTCOMES.ACCOUNT_NOT_FOUND) {
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
    if (o.kind === FUND_OUTCOMES.ACCOUNT_CLOSED) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Account is closed',
        status: 422,
        errors: [
          {
            field: 'accountId',
            code: 'closed',
            message: 'Cannot contribute from closed account',
          },
        ],
      });
    }
    if (o.kind === FUND_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Account currency mismatch',
        status: 422,
        errors: [
          {
            field: 'accountId',
            code: 'currency-mismatch',
            message: 'Contribution currency must match account currency',
          },
        ],
      });
    }
    if (o.kind === FUND_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }
    if (o.kind === FUND_OUTCOMES.REPLAYED) {
      return void reply.status(o.status).send(o.body);
    }
    if (o.kind !== FUND_OUTCOMES.CREATED) return;
    void reply.status(201).send(o.transaction);
  }
}
