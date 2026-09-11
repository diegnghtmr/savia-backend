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
