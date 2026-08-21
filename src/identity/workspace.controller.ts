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

import type { AuthenticatedRequest } from './authenticated-request.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';
import {
  decodeCursor,
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_PORT,
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
}
