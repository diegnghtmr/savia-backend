import type { SaviaScope } from './savia-scopes.js';

export interface SessionIdentity {
  readonly subject: string;
  readonly authMethod: 'session';
  readonly sessionId: string;
}

export interface CliTokenIdentity {
  readonly subject: string;
  readonly authMethod: 'cli_token';
  readonly scopes: readonly SaviaScope[];
}

export interface McpReadIdentity extends McpProposalIdentity {
  readonly authMethod: 'mcp_read';
  readonly workspaceIds: readonly string[];
}

export type RequestIdentity =
  | SessionIdentity
  | CliTokenIdentity
  | McpReadIdentity;

// A proposal credential has no general API identity.
export interface McpProposalIdentity {
  readonly subject: string;
  readonly grantId: string;
}
