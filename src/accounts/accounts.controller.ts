import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  ACCOUNT_LIST_OUTCOMES,
  ACCOUNT_READ_OUTCOMES,
  ACCOUNTS_PORT,
  type AccountsPort,
} from './accounts.port.js';
import { createAccountListQuery } from './account-query.js';
import { AccountQueryValidationError } from './account-query.js';
import type { AuthenticatedRequest } from '../identity/authenticated-request.js';
import { JwtAuthGuard } from '../identity/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../identity/problem-details.js';
import { parseWorkspaceHeader } from '../identity/workspace-header.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}
