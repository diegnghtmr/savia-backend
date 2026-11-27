import {
  Controller,
  Get,
  Inject,
  Optional,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  EXCHANGE_RATE_PORT,
  EXCHANGE_RATE_CREATE_OUTCOMES,
  EXCHANGE_RATE_LIST_OUTCOMES,
  type CreateManualExchangeRateCommand,
  type ExchangeRateListQuery,
  type ExchangeRatePort,
} from './exchange-rate.port.js';
import {
  createManualExchangeRateCommand,
  ExchangeRateCommandValidationError,
} from './exchange-rate-command.js';
import {
  createExchangeRateListQuery,
  ExchangeRateQueryValidationError,
} from './exchange-rate-query.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { FRANKFURTER_RATE_MAX_AGE_HOURS } from '../platform/currency-conversion.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

function withFreshness(body: unknown, responseTimeMs: number): unknown {
  // Replayed response bodies are read from idempotency storage as unknown.
  if (
    typeof body !== 'object' ||
    body === null ||
    !('effectiveAt' in body) ||
    typeof body.effectiveAt !== 'string' ||
    !('source' in body) ||
    typeof body.source !== 'string'
  ) {
    return body;
  }

  const ageHours = (responseTimeMs - Date.parse(body.effectiveAt)) / 3_600_000;
  if (!Number.isFinite(ageHours)) return body;

  return {
    ...body,
    isStale:
      body.source === 'frankfurter' &&
      ageHours >= FRANKFURTER_RATE_MAX_AGE_HOURS,
    ageHours,
  };
}

@Controller('v1/exchange-rates')
@UseGuards(JwtAuthGuard)
export class ExchangeRateController {
  public constructor(
    @Inject(EXCHANGE_RATE_PORT)
    private readonly exchangeRatePort: ExchangeRatePort,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {}

  @Post()
  public async createManualExchangeRate(
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

    let command: CreateManualExchangeRateCommand;
    try {
      command = createManualExchangeRateCommand(request.body);
    } catch (error) {
      if (error instanceof ExchangeRateCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Manual exchange rate create validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.exchangeRatePort.createManual(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === EXCHANGE_RATE_CREATE_OUTCOMES.ALREADY_RECORDED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.EXCHANGE_RATE_ALREADY_RECORDED,
        title: 'Exchange rate already recorded',
        detail:
          'An exchange rate for this workspace, currency pair, and effective timestamp already exists.',
        status: 409,
      });
      return;
    }

    if (outcome.kind === EXCHANGE_RATE_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(withFreshness(outcome.body, this.clock().getTime()));
      return;
    }

    // createManualExchangeRate has NO ETag response header
    void reply
      .status(201)
      .send(withFreshness(outcome.exchangeRate, this.clock().getTime()));
  }

  @Get()
  public async listExchangeRates(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('baseCurrency') baseCurrencyParam?: string,
    @Query('quoteCurrency') quoteCurrencyParam?: string,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
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

    let query: ExchangeRateListQuery;
    try {
      query = createExchangeRateListQuery({
        workspaceId: header.workspaceId,
        ...(baseCurrencyParam === undefined ? {} : { baseCurrencyParam }),
        ...(quoteCurrencyParam === undefined ? {} : { quoteCurrencyParam }),
        ...(fromParam === undefined ? {} : { fromParam }),
        ...(toParam === undefined ? {} : { toParam }),
      });
    } catch (error) {
      if (error instanceof ExchangeRateQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list exchange rates query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.exchangeRatePort.list(
      request.identity.subject,
      query,
    );

    if (outcome.kind === EXCHANGE_RATE_LIST_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    const responseTimeMs = this.clock().getTime();
    const exchangeRates = outcome.exchangeRates.map((rate) =>
      withFreshness(rate, responseTimeMs),
    );
    void reply.status(200).send(exchangeRates);
  }
}
