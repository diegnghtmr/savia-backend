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
  FORECASTS_PORT,
  FORECAST_OUTCOMES,
  type ForecastsPort,
} from './forecast.port.js';
import {
  createForecastCommand,
  ForecastCommandValidationError,
} from './forecast-command.js';
import {
  validateForecastId,
  ForecastQueryValidationError,
} from './forecast-query.js';

@Controller('v1/forecasts')
@UseGuards(JwtAuthGuard)
export class ForecastsController {
  public constructor(
    @Inject(FORECASTS_PORT) private readonly port: ForecastsPort,
  ) {}

  @Post('balance')
  public async createBalance(
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
      command = createForecastCommand(req.body);
    } catch (e) {
      if (e instanceof ForecastCommandValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Forecast validation failed',
          status: 422,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.createBalanceForecast(
      req.identity.subject,
      h.workspaceId,
      command,
      k.key,
    );

    if (o.kind === FORECAST_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (o.kind === FORECAST_OUTCOMES.CONFLICT) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
    }

    if (o.kind === FORECAST_OUTCOMES.REPLAYED) {
      return reply.code(o.status).type('application/json').send(o.body);
    }

    if (o.kind === FORECAST_OUTCOMES.MISSING_RATE) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Missing exchange rate',
        detail: `Missing exchange rate from ${o.fromCurrency} to ${o.toCurrency}`,
        status: 422,
      });
    }

    if (o.kind === FORECAST_OUTCOMES.UNPROCESSABLE) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Forecast request unprocessable',
        status: 422,
        errors: o.violations.map((v) => ({
          field: v.field,
          code: 'invalid',
          message: v.message,
        })),
      });
    }

    return reply.code(202).type('application/json').send(o.job);
  }

  @Get(':forecastId')
  public async get(
    @Param('forecastId') forecastId: string,
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

    let validForecastId: string;
    try {
      validForecastId = validateForecastId(forecastId);
    } catch (e) {
      if (e instanceof ForecastQueryValidationError) {
        return sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid forecast identifier',
          status: 400,
          errors: e.violations,
        });
      }
      throw e;
    }

    const o = await this.port.getForecast(
      req.identity.subject,
      h.workspaceId,
      validForecastId,
    );

    if (o.kind === FORECAST_OUTCOMES.FORBIDDEN) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    }

    if (o.kind === FORECAST_OUTCOMES.NOT_FOUND) {
      return sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Forecast not found',
        status: 404,
      });
    }

    return reply.code(200).type('application/json').send(o.forecast);
  }
}
