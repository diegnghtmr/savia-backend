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
  ACCOUNT_CREATE_OUTCOMES,
  ACCOUNT_LIST_OUTCOMES,
  ACCOUNT_READ_OUTCOMES,
  ACCOUNT_UPDATE_OUTCOMES,
  ACCOUNTS_PORT,
  type AccountsPort,
} from './accounts.port.js';
import { createAccountListQuery } from './account-query.js';
import { AccountQueryValidationError } from './account-query.js';
import {
  createAccountCommand,
  createUpdateAccountCommand,
  AccountCommandValidationError,
  type CreateAccountCommand,
  type UpdateAccountCommand,
} from './account-command.js';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { parseIfMatch } from '../platform/if-match.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { UUID_PATTERN } from '../platform/uuid.js';

@Controller('v1/accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  public constructor(
    @Inject(ACCOUNTS_PORT) private readonly accounts: AccountsPort,
  ) {}

  @Get()
  public async listAccounts(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
    @Query('status') statusParam?: string,
  ): Promise<void> {
    // Épica 2 carries the workspace in a required header instead of the path.
    // The mirror declares 400 on every operation (RULING 49), so a missing or
    // malformed X-Workspace-Id is a transport failure answered with 400.
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
      return;
    }

    let query;
    try {
      query = createAccountListQuery({
        workspaceId: header.workspaceId,
        ...(cursorParam === undefined ? {} : { cursorParam }),
        ...(limitParam === undefined ? {} : { limitParam }),
        ...(statusParam === undefined ? {} : { statusParam }),
      });
    } catch (error) {
      if (error instanceof AccountQueryValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid list accounts query',
          status: 400,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.accounts.list(request.identity.subject, query);

    if (outcome.kind === ACCOUNT_LIST_OUTCOMES.FORBIDDEN) {
      // No membership AND an absent workspace both land here: the authority
      // declares 200/401/403 only, so answering 403 for a nonexistent
      // workspace avoids leaking existence through a 404 that is not declared.
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
  public async createAccount(
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

    let command: CreateAccountCommand;
    try {
      command = createAccountCommand(request.body);
    } catch (error) {
      if (error instanceof AccountCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Account create validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    const outcome = await this.accounts.create(
      request.identity.subject,
      header.workspaceId,
      command,
      keyResult.key,
    );

    if (outcome.kind === ACCOUNT_CREATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === ACCOUNT_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency key reused with different payload',
        status: 409,
      });
      return;
    }

    if (outcome.kind === ACCOUNT_CREATE_OUTCOMES.REPLAYED) {
      let r = reply.status(outcome.status);
      if (outcome.etag) {
        r = r.header('etag', outcome.etag);
      }
      void r.send(outcome.body);
      return;
    }

    void reply
      .header('etag', `"${outcome.account.version}"`)
      .status(201)
      .send(outcome.account);
  }

  @Get(':accountId')
  public async getAccount(
    @Param('accountId') accountId: string,
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

    if (!UUID_PATTERN.test(accountId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid account identifier',
        status: 400,
      });
      return;
    }

    const outcome = await this.accounts.read(
      request.identity.subject,
      header.workspaceId,
      accountId,
    );

    if (outcome.kind === ACCOUNT_READ_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === ACCOUNT_READ_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Account not found',
        status: 404,
      });
      return;
    }

    void reply
      .header('etag', `"${outcome.account.version}"`)
      .status(200)
      .send(outcome.account);
  }

  @Patch(':accountId')
  public async updateAccount(
    @Param('accountId') accountId: string,
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

    if (!UUID_PATTERN.test(accountId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid account identifier',
        status: 400,
      });
      return;
    }

    const ifMatch = parseIfMatch(request.headers['if-match']);
    if (ifMatch.kind === 'malformed') {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
      return;
    }

    let command: UpdateAccountCommand;
    try {
      command = createUpdateAccountCommand(request.body);
    } catch (error) {
      if (error instanceof AccountCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Account update validation failed',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      throw error;
    }

    let expectedVersions: number | readonly number[] | undefined;
    if (ifMatch.kind === 'versions') {
      expectedVersions =
        ifMatch.versions.length === 1 ? ifMatch.versions[0] : ifMatch.versions;
    } else {
      expectedVersions = undefined;
    }

    const outcome = await this.accounts.update(
      request.identity.subject,
      header.workspaceId,
      accountId,
      command,
      expectedVersions,
    );

    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.CLOSED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Account is closed',
        status: 403,
      });
      return;
    }

    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Account not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === ACCOUNT_UPDATE_OUTCOMES.VERSION_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
      return;
    }

    void reply
      .header('etag', `"${outcome.account.version}"`)
      .status(200)
      .send(outcome.account);
  }
}
