import {
  Controller,
  Get,
  Inject,
  Optional,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import {
  ANALYTICS_OUTCOMES,
  ANALYTICS_PORT,
  type AnalyticsPort,
} from './analytics.port.js';
import {
  AnalyticsQueryValidationError,
  createAdvancedAnalyticsQuery,
  createAnalyticsSummaryQuery,
  createCashFlowAnalyticsQuery,
} from './analytics-query.js';

@Controller('v1/analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  public constructor(
    @Inject(ANALYTICS_PORT) private readonly port: AnalyticsPort,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  @Get('summary')
  public async getSummary(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
    @Query('presentationCurrency') presentationCurrencyParam?: string,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok') {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    }

    let query;
    try {
      query = createAnalyticsSummaryQuery({
        workspaceId: h.workspaceId,
        fromParam,
        toParam,
        presentationCurrencyParam,
      });
    } catch (error) {
      if (error instanceof AnalyticsQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid analytics summary query',
          status: 400,
          errors: error.violations,
        });
      }
      throw error;
    }

    const outcome = await this.port.getSummary(req.identity.subject, query);

    if (outcome.kind === ANALYTICS_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (outcome.kind === ANALYTICS_OUTCOMES.MISSING_RATE) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Missing exchange rate',
        status: 400,
        detail: `No exchange rate found for converting ${outcome.fromCurrency} to ${outcome.toCurrency}.`,
      });
    }

    void reply.status(200).send(outcome.summary);
  }

  @Get('cash-flow')
  public async getCashFlow(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
    @Query('granularity') granularityParam?: string,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok') {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    }

    let query;
    try {
      query = createCashFlowAnalyticsQuery({
        workspaceId: h.workspaceId,
        fromParam,
        toParam,
        granularityParam,
      });
    } catch (error) {
      if (error instanceof AnalyticsQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid cash flow analytics query',
          status: 400,
          errors: error.violations,
        });
      }
      throw error;
    }

    const outcome = await this.port.getCashFlow(req.identity.subject, query);

    if (outcome.kind === ANALYTICS_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (outcome.kind === ANALYTICS_OUTCOMES.MISSING_RATE) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Missing exchange rate',
        status: 400,
        detail: `No exchange rate found for converting ${outcome.fromCurrency} to ${outcome.toCurrency}.`,
      });
    }

    void reply.status(200).send(outcome.analytics);
  }

  @Get('advanced')
  public async getAdvanced(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('metric') metricParam?: string,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
  ): Promise<void> {
    const h = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (h.kind !== 'ok') {
      // The 400 is deliberate: existing house convention for malformed workspace header,
      // undeclared on operations, preserved here for consistency across the API.
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    }

    let query;
    try {
      query = createAdvancedAnalyticsQuery(
        {
          workspaceId: h.workspaceId,
          metricParam,
          fromParam,
          toParam,
        },
        this.clock(),
      );
    } catch (error) {
      if (error instanceof AnalyticsQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Invalid advanced analytics query',
          status: 422,
          errors: error.violations,
        });
      }
      throw error;
    }

    const outcome = await this.port.getAdvancedAnalytics(
      req.identity.subject,
      query,
    );

    if (outcome.kind === ANALYTICS_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (outcome.kind === ANALYTICS_OUTCOMES.MISSING_RATE) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Missing exchange rate',
        status: 422,
        detail: `No exchange rate found for converting ${outcome.fromCurrency} to ${outcome.toCurrency}.`,
      });
    }

    void reply.status(200).send(outcome.analytics);
  }
}
