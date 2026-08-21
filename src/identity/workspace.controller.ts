import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { parseIfMatch } from './if-match.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';
import {
  createWorkspaceUpdateCommand,
  WorkspaceCommandValidationError,
  type WorkspaceUpdateCommand,
} from './workspace-command.js';
import {
  decodeCursor,
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_PORT,
  WORKSPACE_UPDATE_OUTCOMES,
  type WorkspaceCursor,
  type WorkspacePort,
} from './workspace.port.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  public constructor(
    @Inject(WORKSPACE_PORT) private readonly workspace: WorkspacePort,
  ) {}

  @Get()
  public async listWorkspaces(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
  ): Promise<void> {
    let limit = 50;
    if (limitParam !== undefined) {
      if (!/^\d+$/.test(limitParam)) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid limit parameter',
          status: 400,
        });
        return;
      }
      limit = Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid limit parameter',
          status: 400,
        });
        return;
      }
    }

    let cursor: WorkspaceCursor | undefined;
    if (cursorParam !== undefined) {
      cursor = decodeCursor(cursorParam);
      if (cursor === undefined) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid cursor parameter',
          status: 400,
        });
        return;
      }
    }

    const page = await this.workspace.list(request.identity.subject, {
      cursor,
      limit,
    });

    void reply.status(200).send(page);
  }

  @Get(':workspaceId')
  public async getWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!UUID_PATTERN.test(workspaceId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid workspace identifier',
        status: 400,
      });
      return;
    }

    const access = await this.workspace.read(
      request.identity.subject,
      workspaceId,
    );

    if (access.kind === WORKSPACE_ACCESS_KINDS.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Workspace not found',
        status: 404,
      });
      return;
    }

    if (access.kind === WORKSPACE_ACCESS_KINDS.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    void reply
      .header('etag', `"${access.workspace.version}"`)
      .status(200)
      .send(access.workspace);
  }

  @Patch(':workspaceId')
  public async updateWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<void> {
    if (!UUID_PATTERN.test(workspaceId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid workspace identifier',
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

    let command: WorkspaceUpdateCommand;
    try {
      command = createWorkspaceUpdateCommand(body);
    } catch (error) {
      if (error instanceof WorkspaceCommandValidationError) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Unprocessable entity',
          status: 422,
          errors: error.violations,
        });
        return;
      }
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Bad request',
        status: 400,
      });
      return;
    }

    const expectedVersion =
      ifMatch.kind === 'version' ? ifMatch.version : undefined;

    const outcome = await this.workspace.update(
      request.identity.subject,
      workspaceId,
      command,
      expectedVersion,
    );

    if (outcome.kind === WORKSPACE_UPDATE_OUTCOMES.OK) {
      void reply
        .header('etag', `"${outcome.version}"`)
        .status(200)
        .send(outcome.workspace);
      return;
    }

    if (outcome.kind === WORKSPACE_UPDATE_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Workspace not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_UPDATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_UPDATE_OUTCOMES.VERSION_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
      return;
    }
  }
}
