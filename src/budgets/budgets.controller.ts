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
  BUDGETS_PORT,
  BUDGET_OUTCOMES,
  type BudgetsPort,
} from './budget.port.js';
import {
  createBudgetCommand,
  BudgetCommandValidationError,
} from './budget-command.js';
import {
  createBudgetListQuery,
  validateBudgetId,
  BudgetQueryValidationError,
} from './budget-query.js';
@Controller('v1/budgets')
@UseGuards(JwtAuthGuard)
export class BudgetsController {
  public constructor(
    @Inject(BUDGETS_PORT) private readonly port: BudgetsPort,
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
      command = createBudgetCommand(req.body);
    } catch (e) {
      if (e instanceof BudgetCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Budget validation failed',
          status: 422,
          errors: e.violations,
        });
      throw e;
    }
    const o = await this.port.createBudget(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );
    if (o.kind === BUDGET_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (o.kind === BUDGET_OUTCOMES.CONFLICT)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    if (o.kind === BUDGET_OUTCOMES.INVALID_SOURCE)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Budget source not found',
        status: 422,
      });
    if (o.kind === BUDGET_OUTCOMES.TOO_MANY_ALLOCATIONS)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Budget allocation limit exceeded',
        status: 422,
      });
    if (o.kind === BUDGET_OUTCOMES.REPLAYED) {
      let r = reply.status(o.status);
      if (o.etag) r = r.header('ETag', o.etag);
      return void r.send(o.body);
    }
    if (o.kind !== BUDGET_OUTCOMES.CREATED) return;
    void reply.status(201).send(o.budget);
  }
  @Get() public async list(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    let q;
    try {
      q = createBudgetListQuery({
        workspaceId: h.workspaceId,
        cursorParam: cursor,
        limitParam: limit,
        fromParam: from,
        toParam: to,
      });
    } catch (e) {
      if (e instanceof BudgetQueryValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid budget list query',
          status: 400,
          errors: e.violations,
        });
      throw e;
    }
    const o = await this.port.listBudgets(req.identity.subject, q);
    if (o.kind === BUDGET_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    void reply.status(200).send(o.page);
  }
  @Get(':budgetId') public async get(
    @Param('budgetId') raw: string,
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
    let id: string;
    try {
      id = validateBudgetId(raw);
    } catch (e) {
      if (e instanceof BudgetQueryValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid budget identifier',
          status: 400,
          errors: e.violations,
        });
      throw e;
    }
    const o = await this.port.getBudget(
      req.identity.subject,
      h.workspaceId,
      id,
    );
    if (o.kind === BUDGET_OUTCOMES.FORBIDDEN)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    if (o.kind === BUDGET_OUTCOMES.NOT_FOUND)
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Budget not found',
        status: 404,
      });
    if (o.kind !== BUDGET_OUTCOMES.FOUND) return;
    void reply
      .status(200)
      .header('ETag', `"${o.budget.version}"`)
      .send(o.budget);
  }
}
