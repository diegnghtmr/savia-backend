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
  LEDGER_PORT,
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  type LedgerPort,
} from './ledger.port.js';
import {
  createTransactionCommand,
  TransactionCommandValidationError,
  type CreateTransactionCommand,
} from './transaction-command.js';
import { TransactionSplitsUnsupportedError } from './splits-guard.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { UUID_PATTERN } from '../platform/uuid.js';

@Controller('v1/transactions')
@UseGuards(JwtAuthGuard)
export class TransactionController {
  public constructor(
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
  ) {}

  @Post()
  public async createTransaction(
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

    let command: CreateTransactionCommand;
    try {
      command = createTransactionCommand(request.body);
    } catch (error) {
      if (error instanceof TransactionSplitsUnsupportedError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.TRANSACTION_SPLITS_UNSUPPORTED,
          title: 'Transaction splits unsupported',
          detail: 'Transaction splits are not supported.',
          status: 422,
        });
        return;
      }
      if (error instanceof TransactionCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Transaction create validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.ledger.create(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.ACCOUNT_UNRESOLVED,
        title: 'Account unresolved',
        detail: 'The specified account was not found in the workspace.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.ACCOUNT_CLOSED,
        title: 'Account is closed',
        detail: 'Transactions cannot be created against a closed account.',
        status: 422,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    void reply
      .header('etag', `"${outcome.transaction.version}"`)
      .status(201)
      .send(outcome.transaction);
  }

  @Get(':transactionId')
  public async getTransaction(
    @Param('transactionId') transactionId: string,
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

    if (!UUID_PATTERN.test(transactionId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid transaction identifier',
        status: 400,
      });
      return;
    }

    const outcome = await this.ledger.read(
      request.identity.subject,
      header.workspaceId,
      transactionId,
    );

    if (outcome.kind === TRANSACTION_READ_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_READ_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Transaction not found',
        status: 404,
      });
      return;
    }

    void reply
      .header('etag', `"${outcome.transaction.version}"`)
      .status(200)
      .send(outcome.transaction);
  }
}
