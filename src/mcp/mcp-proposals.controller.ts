import {
  Body,
  Controller,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { validateIdempotencyKey } from '../platform/idempotency-key.js';
import {
  McpProposalAuthGuard,
  type McpProposalRequest,
} from '../platform/jwt-auth.guard.js';
import { PROBLEM_TYPES, sendProblem } from '../platform/problem-details.js';
import type { McpProposalIdentity } from '../platform/request-identity.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';

export const MCP_PROPOSALS_PORT = Symbol('McpProposalsPort');
type Outcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'invalid' | 'forbidden' | 'conflict' };

export type McpProposalsPort = (
  identity: McpProposalIdentity,
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>,
  key: string,
) => Promise<Outcome>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

@Controller('v1/mcp/proposals')
@UseGuards(McpProposalAuthGuard)
export class McpProposalsController {
  public constructor(
    @Inject(MCP_PROPOSALS_PORT) private readonly propose: McpProposalsPort,
  ) {}

  @Post()
  public async create(
    @Req() request: McpProposalRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (workspace.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid X-Workspace-Id header',
        status: 400,
      });
    const key = validateIdempotencyKey(request.headers['idempotency-key']);
    if (key.kind !== 'ok')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.BAD_REQUEST,
        title: 'Invalid Idempotency-Key header',
        status: 400,
      });
    let outcome: Outcome = { kind: 'invalid' };
    if (
      isObject(body) &&
      Object.keys(body).length === 2 &&
      Object.hasOwn(body, 'toolName') &&
      Object.hasOwn(body, 'arguments') &&
      typeof body.toolName === 'string' &&
      isObject(body.arguments)
    ) {
      outcome = await this.propose(
        request.proposalIdentity,
        workspace.workspaceId,
        body.toolName,
        body.arguments,
        key.key,
      );
    }
    if (outcome.kind === 'ok')
      return reply.code(201).type('application/json').send(outcome.body);
    if (outcome.kind === 'forbidden')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'MCP grant does not authorize the proposal',
        status: 403,
      });
    if (outcome.kind === 'conflict')
      return sendProblem(reply, {
        type: PROBLEM_TYPES.CONFLICT,
        title: 'MCP proposal conflict',
        status: 409,
      });
    return sendProblem(reply, {
      type: PROBLEM_TYPES.UNPROCESSABLE,
      title: 'Invalid MCP proposal tool or arguments',
      status: 422,
    });
  }
}
