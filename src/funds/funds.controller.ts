import {
  Controller,
  Get,
  Inject,
  Param,
  Patch,
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
import { canonicalJson } from '../platform/idempotency.service.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  FUNDS_PORT,
  FUND_OUTCOMES,
  type FundsPort,
  type FundUpdateOutcome,
} from './fund.port.js';
import {
  createFundCommand,
  createFundContributionCommand,
  createFundWithdrawalCommand,
  FundCommandValidationError,
  updateFundCommand,
} from './fund-command.js';
import {
  createFundListQuery,
  validateFundId,
  FundQueryValidationError,
} from './fund-query.js';

const STRONG_ETAG = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

const UPDATE_VALIDATION = {
  'currency-mismatch': [
    'targetAmount.currency',
    'invalid',
    'Target amount currency must match fund currency',
  ],
  'linked-account-not-found': [
    'linkedAccountId',
    'not-found',
    'linkedAccountId not found in workspace',
  ],
  'inactive-members': [
    'responsibleMemberIds',
    'invalid',
    'Each ID must identify an active workspace membership',
  ],
} as const;

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

  @Get(':fundId')
  public async detail(
    @Param('fundId') rawFundId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const address = this.fundAddress(rawFundId, req, reply);
    if (!address) return;
    this.sendFundDetail(
      reply,
      await this.port.getFund(
        req.identity.subject,
        address.workspaceId,
        address.fundId,
      ),
    );
  }

  @Patch(':fundId')
  public async update(
    @Param('fundId') rawFundId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const address = this.fundAddress(rawFundId, req, reply);
    if (!address) return;
    const rawMatch = req.headers['if-match'];
    if (rawMatch === undefined) {
      return sendProblem(reply, {
        type: 'https://savia.app/problems/precondition-required',
        title: 'If-Match header is required',
        status: 428,
      });
    }
    const ifMatch = typeof rawMatch === 'string' ? rawMatch.trim() : '';
    if (!STRONG_ETAG.test(ifMatch)) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'If-Match must contain one strong ETag',
        status: 400,
      });
    }
    const key = this.commandKey(req, reply);
    if (!key) return;
    try {
      const command = updateFundCommand(req.body);
      this.sendFundDetail(
        reply,
        await this.port.updateFund(
          req.identity.subject,
          address.workspaceId,
          address.fundId,
          command,
          ifMatch,
          key,
        ),
      );
    } catch (e) {
      if (!(e instanceof FundCommandValidationError)) throw e;
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Fund validation failed',
        status: 422,
        errors: e.violations,
      });
    }
  }

  private sendFundDetail(
    reply: FastifyReply,
    outcome: FundUpdateOutcome,
  ): void {
    switch (outcome.kind) {
      case 'ok':
        void reply
          .header('ETag', outcome.fund.etag)
          .type('application/json')
          .status(200)
          .send(canonicalJson(outcome.fund));
        return;
      case 'replayed':
        if (outcome.etag) reply.header('ETag', outcome.etag);
        void reply
          .type('application/json')
          .status(outcome.status)
          .send(canonicalJson(outcome.body));
        return;
      case 'forbidden':
        return sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
      case 'not-found':
        return sendProblem(reply, {
          type: PROBLEM_TYPES.NOT_FOUND,
          title: 'Fund not found',
          status: 404,
        });
      case 'conflict':
        return sendProblem(reply, {
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Idempotency key reused with different payload',
          status: 409,
        });
      case 'stale':
        return sendProblem(reply, {
          type: PROBLEM_TYPES.PRECONDITION_FAILED,
          title: 'Fund ETag does not match',
          status: 412,
        });
      default: {
        const [field, code, message] = UPDATE_VALIDATION[outcome.kind];
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Fund validation failed',
          status: 422,
          errors: [{ field, code, message }],
        });
      }
    }
  }

  private fundAddress(
    rawFundId: string,
    req: AuthenticatedRequest,
    reply: FastifyReply,
  ) {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return undefined;
    }
    try {
      return { workspaceId: h.workspaceId, fundId: validateFundId(rawFundId) };
    } catch (e) {
      if (!(e instanceof FundQueryValidationError)) throw e;
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid fund identifier',
        status: 400,
        errors: e.violations,
      });
      return undefined;
    }
  }

  private commandKey(
    req: AuthenticatedRequest,
    reply: FastifyReply,
  ): string | undefined {
    const k = validateIdempotencyKey(req.headers['idempotency-key']);
    if (k.kind === 'ok') return k.key;
    sendProblem(reply, {
      type: PROBLEM_TYPES.BAD_REQUEST,
      title: 'Invalid Idempotency-Key header',
      detail: k.reason,
      status: 400,
    });
    return undefined;
  }

  @Post(':fundId/contributions')
  public contribute(
    @Param('fundId') rawFundId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.move(rawFundId, req, reply, false);
  }

  @Post(':fundId/withdrawals')
  public withdraw(
    @Param('fundId') rawFundId: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.move(rawFundId, req, reply, true);
  }

  private async move(
    rawFundId: string,
    req: AuthenticatedRequest,
    reply: FastifyReply,
    withdraw: boolean,
  ): Promise<void> {
    const address = this.fundAddress(rawFundId, req, reply);
    if (!address) return;
    const key = this.commandKey(req, reply);
    if (!key) return;
    const { workspaceId, fundId } = address;
    const { subject } = req.identity;
    const validationTitle = withdraw
      ? 'Fund withdrawal validation failed'
      : 'Fund contribution validation failed';
    let o;
    try {
      o = withdraw
        ? await this.port.withdrawFromFund(
            subject,
            workspaceId,
            fundId,
            createFundWithdrawalCommand(req.body),
            key,
          )
        : await this.port.contributeToFund(
            subject,
            workspaceId,
            fundId,
            createFundContributionCommand(req.body),
            key,
          );
    } catch (e) {
      if (!(e instanceof FundCommandValidationError)) throw e;
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: validationTitle,
        status: 422,
        errors: e.violations,
      });
    }

    if (o.kind === FUND_OUTCOMES.INSUFFICIENT_SAVED) {
      return sendProblem(reply, {
        type: 'https://savia.app/problems/insufficient-fund-balance',
        title: 'Withdrawal exceeds the saved amount',
        status: 422,
      });
    }

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
        title: validationTitle,
        status: 422,
        errors: [
          {
            field: 'amount.currency',
            code: 'invalid',
            message: withdraw
              ? 'Withdrawal currency must match fund currency'
              : 'Contribution currency must match fund currency',
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
            message: withdraw
              ? 'Cannot withdraw to closed account'
              : 'Cannot contribute from closed account',
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
            message: withdraw
              ? 'Withdrawal currency must match account currency'
              : 'Contribution currency must match account currency',
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
