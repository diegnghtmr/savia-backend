export const AUTH_METHODS = {
  SESSION: 'session',
  CLI_TOKEN: 'cli_token',
} as const;

export const SAVIA_SCOPES = {
  ACCOUNTS_READ: 'accounts:read',
  ACCOUNTS_WRITE: 'accounts:write',
  TRANSACTIONS_READ: 'transactions:read',
  TRANSACTIONS_WRITE: 'transactions:write',
  BUDGETS_READ: 'budgets:read',
  BUDGETS_WRITE: 'budgets:write',
  REPORTS_READ: 'reports:read',
  REPORTS_WRITE: 'reports:write',
  WORKSPACE_ADMIN: 'workspace:admin',
} as const;

export type AuthMethod = (typeof AUTH_METHODS)[keyof typeof AUTH_METHODS];
export type SaviaScope = (typeof SAVIA_SCOPES)[keyof typeof SAVIA_SCOPES];
