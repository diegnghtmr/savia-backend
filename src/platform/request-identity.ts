import type { SaviaScope } from './savia-scopes.js';

export interface SessionIdentity {
  readonly subject: string;
  readonly authMethod: 'session';
}

export interface CliTokenIdentity {
  readonly subject: string;
  readonly authMethod: 'cli_token';
  readonly scopes: readonly SaviaScope[];
}

export type RequestIdentity = SessionIdentity | CliTokenIdentity;

// A proposal credential has no general API identity.
export interface McpProposalIdentity {
  readonly subject: string;
  readonly grantId: string;
}
