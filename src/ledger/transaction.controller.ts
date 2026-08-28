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

import {
  LEDGER_PORT,
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_LIST_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  TRANSACTION_UPDATE_OUTCOMES,
  type LedgerPort,
  type TransactionListQuery,
  type UpdateTransactionCommand,
} from './ledger.port.js';
import {
  createTransactionCommand,
  createUpdateTransactionCommand,
  TransactionCommandValidationError,
  type CreateTransactionCommand,
} from './transaction-command.js';
import {
  createTransactionListQuery,
  TransactionQueryValidationError,
} from './transaction-query.js';
import { TransactionSplitsUnsupportedError } from './splits-guard.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { parseIfMatch } from '../platform/if-match.js';
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

  @Get()
  public async listTransactions(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
    @Query('accountId') accountIdParam?: string,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
    @Query('categoryId') categoryIdParam?: string,
    @Query('status') statusParam?: string,
    @Query('query') queryParam?: string,
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

    let query: TransactionListQuery;
    try {
      query = createTransactionListQuery({
        workspaceId: header.workspaceId,
        ...(cursorParam === undefined ? {} : { cursorParam }),
        ...(limitParam === undefined ? {} : { limitParam }),
        ...(accountIdParam === undefined ? {} : { accountIdParam }),
        ...(fromParam === undefined ? {} : { fromParam }),
        ...(toParam === undefined ? {} : { toParam }),
        ...(categoryIdParam === undefined ? {} : { categoryIdParam }),
        ...(statusParam === undefined ? {} : { statusParam }),
        ...(queryParam === undefined ? {} : { queryParam }),
      });
    } catch (error) {
      if (error instanceof TransactionQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list transactions query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.ledger.list(request.identity.subject, query);

    if (outcome.kind === TRANSACTION_LIST_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    void reply.status(200).send(outcome.page);
  }

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

  @Patch(':transactionId')
  public async updateTransaction(
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

    const ifMatchResult = parseIfMatch(request.headers['if-match']);
    if (ifMatchResult.kind === 'malformed') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Malformed If-Match header',
        status: 412,
      });
      return;
    }

    let command: UpdateTransactionCommand;
    try {
      command = createUpdateTransactionCommand(request.body);
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
          title: 'Transaction update validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    let expectedVersions: number | readonly number[] | undefined;
    if (ifMatchResult.kind === 'versions') {
      expectedVersions =
        ifMatchResult.versions.length === 1
          ? ifMatchResult.versions[0]
          : ifMatchResult.versions;
    } else {
      expectedVersions = undefined;
    }

    const outcome = await this.ledger.update(
      request.identity.subject,
      header.workspaceId,
      transactionId,
      command,
      keyResult.key,
      expectedVersions,
    );

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.VOIDED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.TRANSACTION_VOIDED,
        title: 'Transaction is voided',
        detail: 'Voided transactions cannot be modified.',
        status: 409,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Transaction not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Resource version mismatch',
        status: 412,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.RECONCILED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.TRANSACTION_RECONCILED,
        title: 'Transaction is reconciled',
        detail: 'Reconciled transactions cannot be modified.',
        status: 409,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === TRANSACTION_UPDATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    void reply
      .header('etag', `"${outcome.transaction.version}"`)
      .status(200)
      .send(outcome.transaction);
  }
}
