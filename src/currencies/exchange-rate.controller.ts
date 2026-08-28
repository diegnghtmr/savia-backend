import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  EXCHANGE_RATE_PORT,
  EXCHANGE_RATE_CREATE_OUTCOMES,
  type CreateManualExchangeRateCommand,
  type ExchangeRatePort,
} from './exchange-rate.port.js';
import {
  createManualExchangeRateCommand,
  ExchangeRateCommandValidationError,
} from './exchange-rate-command.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/exchange-rates')
@UseGuards(JwtAuthGuard)
export class ExchangeRateController {
  public constructor(
    @Inject(EXCHANGE_RATE_PORT)
    private readonly exchangeRatePort: ExchangeRatePort,
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
      void r.send(outcome.body);
      return;
    }

    // createManualExchangeRate has NO ETag response header
    void reply.status(201).send(outcome.exchangeRate);
  }
}
