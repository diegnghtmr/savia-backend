import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../platform/authenticated-request.js';
import { JwtAuthGuard } from '../platform/jwt-auth.guard.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import {
  AgentMessageValidationError,
  createAgentMessageCommand,
} from './agent-message-command.js';
import {
  AGENT_MESSAGE_OUTCOMES,
  AGENT_MESSAGE_PORT,
  type AgentMessagePort,
} from './agent-message.port.js';

@Controller('v1/agent/conversations')
@UseGuards(JwtAuthGuard)
export class AgentMessagesController {
  public constructor(
    @Inject(AGENT_MESSAGE_PORT) private readonly port: AgentMessagePort,
  ) {}
  @Post(':conversationId/messages')
  public async send(
    @Req() req: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = parseWorkspaceHeader(req.headers['x-workspace-id']);
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    try {
      const command = createAgentMessageCommand(body);
      if (workspace.kind !== 'ok' || key.kind !== 'ok')
        return sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
      const outcome = await this.port.prepare(
        req.identity.subject,
        workspace.workspaceId,
        conversationId,
        key.key,
        command,
      );
      if (outcome.kind === AGENT_MESSAGE_OUTCOMES.NOT_FOUND)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.NOT_FOUND,
          title: 'Agent conversation not found',
          status: 404,
        });
      if (outcome.kind === AGENT_MESSAGE_OUTCOMES.CONFLICT)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Agent message already in flight',
          detail:
            'Retry after the existing run completes or use a new Idempotency-Key.',
          status: 409,
        });
      if (outcome.kind === AGENT_MESSAGE_OUTCOMES.RATE_LIMITED) {
        reply.header('Retry-After', outcome.retryAfter);
        return sendProblem(reply, {
          type: PROBLEM_TYPES.CONFLICT,
          title: 'Rate limit exceeded',
          status: 429,
        });
      }
      if (outcome.kind === AGENT_MESSAGE_OUTCOMES.FORBIDDEN)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const controller = new AbortController();
      req.raw.once('close', () => controller.abort());
      const write = (event: {
        type: string;
        runId: string;
        timestamp: string;
        data: Record<string, unknown>;
      }) => {
        if (!controller.signal.aborted)
          reply.raw.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
      };
      await this.port.execute(
        req.identity.subject,
        workspace.workspaceId,
        conversationId,
        key.key,
        outcome.runId,
        command,
        controller.signal,
        write,
        outcome.replay,
      );
      if (!controller.signal.aborted) reply.raw.end();
    } catch (error) {
      if (error instanceof AgentMessageValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Agent message validation failed',
          status: 422,
          errors: error.violations,
        });
      throw error;
    }
  }
}
