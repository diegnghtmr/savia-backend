import {
  Body,
  Controller,
  Delete,
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

import type { AuthenticatedRequest } from './authenticated-request.js';
import { validateIdempotencyKey } from './idempotency-key.js';
import { parseIfMatch } from './if-match.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from './problem-details.js';
import {
  createWorkspaceCreateCommand,
  createWorkspaceUpdateCommand,
  WorkspaceCommandValidationError,
  type WorkspaceCreateCommand,
  type WorkspaceUpdateCommand,
} from './workspace-command.js';
import {
  createWorkspaceMemberUpdateCommand,
  WorkspaceMemberCommandValidationError,
  type WorkspaceMemberUpdateCommand,
} from './workspace-member-command.js';
import {
  decodeMemberCursor,
  WORKSPACE_MEMBER_LIST_OUTCOMES,
  WORKSPACE_MEMBER_PORT,
  WORKSPACE_MEMBER_UPDATE_OUTCOMES,
  type WorkspaceMemberCursor,
  type WorkspaceMemberPort,
} from './workspace-member.port.js';
import {
  decodeCursor,
  WORKSPACE_ACCESS_KINDS,
  WORKSPACE_CREATE_OUTCOME_KINDS,
  WORKSPACE_DELETE_OUTCOME_KINDS,
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
    @Inject(WORKSPACE_MEMBER_PORT)
    private readonly members: WorkspaceMemberPort,
  ) {}

  @Post()
  public async createWorkspace(
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
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

    let command: WorkspaceCreateCommand;
    try {
      command = createWorkspaceCreateCommand(request.body);
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

    const outcome = await this.workspace.create(
      request.identity.subject,
      command,
      keyResult.key,
    );

    if (outcome.kind === WORKSPACE_CREATE_OUTCOME_KINDS.CREATED) {
      void reply
        .header('etag', `"${outcome.workspace.version}"`)
        .status(201)
        .send(outcome.workspace);
      return;
    }

    if (outcome.kind === WORKSPACE_CREATE_OUTCOME_KINDS.REPLAYED) {
      if (outcome.etag !== null) {
        void reply.header('etag', outcome.etag);
      }
      void reply.status(outcome.status).send(outcome.body);
      return;
    }

    if (outcome.kind === WORKSPACE_CREATE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency conflict',
        status: 409,
      });
      return;
    }
  }

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

  @Get(':workspaceId/members')
  public async listWorkspaceMembers(
    @Param('workspaceId') workspaceId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursorParam?: string,
    @Query('limit') limitParam?: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(workspaceId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid workspace identifier',
        status: 400,
      });
      return;
    }

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

    let cursor: WorkspaceMemberCursor | undefined;
    if (cursorParam !== undefined) {
      cursor = decodeMemberCursor(cursorParam, workspaceId);
      if (cursor === undefined) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.BAD_REQUEST,
          title: 'Invalid cursor parameter',
          status: 400,
        });
        return;
      }
    }

    const outcome = await this.members.listWorkspaceMembers(
      request.identity.subject,
      workspaceId,
      { cursor, limit },
    );

    if (outcome.kind === WORKSPACE_MEMBER_LIST_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Workspace not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_LIST_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    void reply.status(200).send(outcome.page);
  }

  @Patch(':workspaceId/members/:memberId')
  public async updateWorkspaceMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<void> {
    if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(memberId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid identifier parameter',
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

    let command: WorkspaceMemberUpdateCommand;
    try {
      command = createWorkspaceMemberUpdateCommand(body);
    } catch (error) {
      if (error instanceof WorkspaceMemberCommandValidationError) {
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

    let expectedVersions: number | readonly number[] | undefined;
    if (ifMatch.kind === 'versions') {
      expectedVersions =
        ifMatch.versions.length === 1 ? ifMatch.versions[0] : ifMatch.versions;
    } else {
      expectedVersions = undefined;
    }

    const outcome = await this.members.updateWorkspaceMember(
      request.identity.subject,
      workspaceId,
      memberId,
      command,
      expectedVersions,
    );

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.OK) {
      void reply
        .header('etag', `"${outcome.version}"`)
        .status(200)
        .send(outcome.member);
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Workspace not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.PERSONAL_WORKSPACE) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PERSONAL_WORKSPACE_MEMBERSHIP,
        title: 'Personal workspace membership cannot be updated',
        status: 409,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.LAST_OWNER_REQUIRED) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.LAST_OWNER_REQUIRED,
        title: 'Collaborative workspace requires at least one active owner',
        status: 409,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.VERSION_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.PRECONDITION_FAILED,
        title: 'Precondition failed',
        status: 412,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_MEMBER_UPDATE_OUTCOMES.CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Conflict',
        status: 409,
      });
      return;
    }
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

    // RFC 9110 section 13.1.1 defines If-Match: * as evaluating to false if the
    // representation does not exist, which would technically warrant 412.
    // However, this API cannot distinguish an absent workspace from one where
    // the caller is not a member, answering 404 for both in getWorkspace.
    // Answering 404 here is a deliberate deviation from RFC 9110 to maintain
    // consistency with getWorkspace and avoid leaking existence information.
    let expectedVersions: number | readonly number[] | undefined;
    if (ifMatch.kind === 'versions') {
      expectedVersions =
        ifMatch.versions.length === 1 ? ifMatch.versions[0] : ifMatch.versions;
    } else if (ifMatch.kind === 'any') {
      // If-Match: * requires representation to exist; if absent or forbidden,
      // workspace.update will answer NOT_FOUND (404) or FORBIDDEN (403).
      expectedVersions = undefined;
    } else {
      // ifMatch.kind === 'absent'
      expectedVersions = undefined;
    }

    const outcome = await this.workspace.update(
      request.identity.subject,
      workspaceId,
      command,
      expectedVersions,
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

  @Delete(':workspaceId')
  public async deleteWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
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

    if (!UUID_PATTERN.test(workspaceId)) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid workspace identifier',
        status: 400,
      });
      return;
    }

    const outcome = await this.workspace.delete(
      request.identity.subject,
      workspaceId,
      keyResult.key,
    );

    if (outcome.kind === WORKSPACE_DELETE_OUTCOME_KINDS.DELETED) {
      void reply.status(204).send();
      return;
    }

    if (outcome.kind === WORKSPACE_DELETE_OUTCOME_KINDS.NOT_FOUND) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Workspace not found',
        status: 404,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_DELETE_OUTCOME_KINDS.FORBIDDEN) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_DELETE_OUTCOME_KINDS.UNPROCESSABLE) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.UNPROCESSABLE,
        title: 'Unprocessable entity',
        status: 422,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_DELETE_OUTCOME_KINDS.IDEMPOTENCY_CONFLICT) {
      sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency conflict',
        status: 409,
      });
      return;
    }

    if (outcome.kind === WORKSPACE_DELETE_OUTCOME_KINDS.REPLAYED) {
      if (outcome.status === 204) {
        void reply.status(204).send();
        return;
      }
      // A replayed refusal re-renders through sendProblem from a status->problem map rather than
      // echoing a stored body, so traceId and instance stay bound to the actual replaying
      // request. Note this in a comment as a deliberate, narrow deviation from byte-identical replay.
      if (outcome.status === 403) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
        return;
      }
      if (outcome.status === 404) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.NOT_FOUND,
          title: 'Workspace not found',
          status: 404,
        });
        return;
      }
      if (outcome.status === 422) {
        sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Unprocessable entity',
          status: 422,
        });
        return;
      }
      void reply.status(outcome.status).send();
      return;
    }
  }
}
