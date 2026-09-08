import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
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
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  createMcpGrantCommand,
  McpGrantCommandValidationError,
} from './mcp-grant-command.js';
import {
  MCP_GRANT_OUTCOMES,
  MCP_GRANTS_PORT,
  type McpGrantPort,
} from './mcp-grant.port.js';
@Controller('v1/mcp/grants')
@UseGuards(JwtAuthGuard)
export class McpGrantsController {
  public constructor(
    @Inject(MCP_GRANTS_PORT) private readonly port: McpGrantPort,
  ) {}
  @Get() public async list(
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<void> {
    const n = limit === undefined ? 50 : Number(limit);
    const decoded = cursor === undefined ? undefined : decodeCursor(cursor);
    if (
      !Number.isInteger(n) ||
      n < 1 ||
      n > 200 ||
      (cursor !== undefined && !decoded)
    )
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid grant list query',
        status: 400,
      });
    const outcome = await this.port.listMcpGrants(req.identity.subject, {
      limit: n,
      ...(decoded ? { cursor: decoded } : {}),
    });
    if (outcome.kind === MCP_GRANT_OUTCOMES.OK)
      void reply.status(200).send(outcome.page);
  }
  @Post() public async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (key.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        status: 400,
      });
    try {
      const outcome = await this.port.createMcpGrant(
        req.identity.subject,
        createMcpGrantCommand(body),
        key.key,
      );
      if (outcome.kind === MCP_GRANT_OUTCOMES.CREATED)
        return void reply.status(201).send(outcome.grant);
      if (outcome.kind === MCP_GRANT_OUTCOMES.FORBIDDEN)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.FORBIDDEN,
          title: 'Workspace access forbidden',
          status: 403,
        });
      if (outcome.kind === MCP_GRANT_OUTCOMES.INVALID)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'Account is outside the grant workspaces',
          status: 422,
        });
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Idempotency conflict',
        status: 409,
      });
    } catch (error) {
      if (error instanceof McpGrantCommandValidationError)
        return sendProblem(reply, {
          type: PROBLEM_TYPES.UNPROCESSABLE,
          title: 'MCP grant validation failed',
          status: 422,
          errors: error.violations,
        });
      throw error;
    }
  }
  @Delete(':grantId') public async revoke(
    @Param('grantId') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const key = validateIdempotencyKey(req.headers['idempotency-key']);
    if (key.kind !== 'ok' || !UUID_PATTERN.test(id))
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid grant request',
        status: 400,
      });
    const outcome = await this.port.revokeMcpGrant(
      req.identity.subject,
      id.toLowerCase(),
      key.key,
    );
    if (outcome.kind === MCP_GRANT_OUTCOMES.OK)
      return void reply.status(204).send();
    sendProblem(reply, {
      type:
        outcome.kind === MCP_GRANT_OUTCOMES.NOT_FOUND
          ? PROBLEM_TYPES.NOT_FOUND
          : PROBLEM_TYPES.CONFLICT,
      title:
        outcome.kind === MCP_GRANT_OUTCOMES.NOT_FOUND
          ? 'Grant not found'
          : 'Grant cannot be revoked',
      status: outcome.kind === MCP_GRANT_OUTCOMES.NOT_FOUND ? 404 : 409,
    });
  }
}
