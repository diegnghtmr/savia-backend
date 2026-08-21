import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from './authenticated-request.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';
import {
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_PORT,
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
