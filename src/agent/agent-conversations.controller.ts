import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { decodeCursor } from '../platform/cursor.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  AgentConversationValidationError,
  createAgentConversationCommand,
} from './agent-conversation-command.js';
import {
  AGENT_CONVERSATIONS_PORT,
  AGENT_CONVERSATION_OUTCOMES,
  type AgentConversationPort,
} from './agent-conversation.port.js';
@Controller('v1/agent/conversations')
@UseGuards(JwtAuthGuard)
export class AgentConversationsController {
  public constructor(
    @Inject(AGENT_CONVERSATIONS_PORT)
    private readonly port: AgentConversationPort,
  ) {}
  @Get() public async list(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') rawCursor?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<void> {
    const workspace = parseWorkspaceHeader(req.headers['x-workspace-id']);
    if (workspace.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    const cursor =
      rawCursor === undefined
        ? undefined
        : decodeCursor(rawCursor, workspace.workspaceId);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (rawCursor !== undefined && !cursor)
    )
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    const outcome = await this.port.listAgentConversations(
      req.identity.subject,
      workspace.workspaceId,
      { limit, ...(cursor ? { cursor } : {}) },
    );
    if (outcome.kind === AGENT_CONVERSATION_OUTCOMES.OK)
      void reply.status(200).send(outcome.page);
    else
      sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
  }
  @Post() public async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = parseWorkspaceHeader(req.headers['x-workspace-id']);
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (workspace.kind !== 'ok' || key.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Workspace access forbidden',
        status: 403,
      });
    try {
      const outcome = await this.port.createAgentConversation(
        req.identity.subject,
        workspace.workspaceId,
        createAgentConversationCommand(body),
        key.key,
      );
      if (outcome.kind === AGENT_CONVERSATION_OUTCOMES.CREATED)
        return void reply.status(201).send(outcome.conversation);
      if (outcome.kind === AGENT_CONVERSATION_OUTCOMES.FORBIDDEN)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
      if (outcome.kind === AGENT_CONVERSATION_OUTCOMES.INVALID)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Credential is unusable',
          status: 422,
        });
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency conflict',
        status: 409,
      });
    } catch (error) {
      if (error instanceof AgentConversationValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Agent conversation validation failed',
          status: 422,
          errors: error.violations,
        });
      throw error;
    }
  }
}
