import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  CURRENCY_EXCHANGE_PORT,
  CURRENCY_EXCHANGE_CREATE_OUTCOMES,
  type CreateCurrencyExchangeCommand,
  type CurrencyExchangePort,
} from './currency-exchange.port.js';
import {
  createCurrencyExchangeCommand,
  CurrencyExchangeCommandValidationError,
} from './currency-exchange-command.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

@Controller('v1/currency-exchanges')
@UseGuards(JwtAuthGuard)
export class CurrencyExchangeController {
  public constructor(
    @Inject(CURRENCY_EXCHANGE_PORT)
    private readonly currencyExchangePort: CurrencyExchangePort,
  ) {}

  @Post()
  public async createCurrencyExchange(
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

    let command: CreateCurrencyExchangeCommand;
    try {
      command = createCurrencyExchangeCommand(request.body);
    } catch (error) {
      if (error instanceof CurrencyExchangeCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Currency exchange create validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.currencyExchangePort.create(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.ACCOUNT_UNRESOLVED,
        title: 'Account unresolved',
        detail: 'The specified account was not found in the workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_CLOSED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.ACCOUNT_CLOSED,
        title: 'Account is closed',
        detail: 'Transfers cannot be created against a closed account.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.TRANSFER_CURRENCY_MISMATCH,
        title: 'Transfer currency mismatch',
        detail:
          'Source and destination accounts must have differing currencies matching their amounts.',
        status: 422,
      });
      return;
    }

    if (
      outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT
    ) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    // createCurrencyExchange has NO ETag response header
    void reply.status(201).send(outcome.transfer);
  }
}
