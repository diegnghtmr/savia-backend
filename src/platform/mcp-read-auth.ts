import { SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { McpProposalIdentity } from './request-identity.js';
import type { SaviaScope } from './savia-scopes.js';
import { registerMcpRead } from './mcp-tool-catalog.js';

export const MCP_READ_METADATA = 'savia:mcp-read';
export const MCP_READ_ADMISSION = Symbol('McpReadAdmission');

type Resource =
  | 'workspace'
  | 'workspace-list'
  | 'account-path'
  | 'account-query';
export interface McpReadDeclaration {
  readonly toolName: string;
  readonly resource: Resource;
}

export function McpRead(
  toolName: string,
  requiredScopes: readonly SaviaScope[],
  resource: Resource = 'workspace',
) {
  registerMcpRead(toolName, requiredScopes);
  return SetMetadata(MCP_READ_METADATA, {
    toolName,
    resource,
  } satisfies McpReadDeclaration);
}

export type McpReadAdmission = (
  identity: McpProposalIdentity,
  operation: McpReadDeclaration,
  request: FastifyRequest,
) => Promise<readonly string[] | undefined>;
