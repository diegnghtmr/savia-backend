import { SAVIA_SCOPES, type SaviaScope } from './savia-scopes.js';

export const CLI_SCOPE_POLICY: ReadonlyMap<string, readonly SaviaScope[]> =
  new Map([
    [
      routeKey('DELETE', '/v1/workspaces/:workspaceId/members/:memberId'),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [routeKey('GET', '/v1/accounts'), [SAVIA_SCOPES.ACCOUNTS_READ]],
    [routeKey('GET', '/v1/accounts/:accountId'), [SAVIA_SCOPES.ACCOUNTS_READ]],
    [
      routeKey('GET', '/v1/accounts/:accountId/balance'),
      [SAVIA_SCOPES.ACCOUNTS_READ],
    ],
    [routeKey('GET', '/v1/ai/providers'), [SAVIA_SCOPES.WORKSPACE_ADMIN]],
    [routeKey('GET', '/v1/analytics/advanced'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('GET', '/v1/analytics/cash-flow'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('GET', '/v1/analytics/summary'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('GET', '/v1/budgets'), [SAVIA_SCOPES.BUDGETS_READ]],
    [routeKey('GET', '/v1/budgets/:budgetId'), [SAVIA_SCOPES.BUDGETS_READ]],
    [routeKey('GET', '/v1/categories'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [routeKey('GET', '/v1/debts'), [SAVIA_SCOPES.BUDGETS_READ]],
    [routeKey('GET', '/v1/exchange-rates'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [
      routeKey('GET', '/v1/export-jobs/:exportJobId'),
      [SAVIA_SCOPES.REPORTS_READ],
    ],
    [routeKey('GET', '/v1/forecasts/:forecastId'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('GET', '/v1/funds'), [SAVIA_SCOPES.BUDGETS_READ]],
    [
      routeKey('GET', '/v1/import-jobs/:importJobId'),
      [SAVIA_SCOPES.TRANSACTIONS_READ],
    ],
    [routeKey('GET', '/v1/jobs/:jobId'), []],
    [routeKey('GET', '/v1/me'), []],
    [routeKey('GET', '/v1/notifications'), []],
    [routeKey('GET', '/v1/payees'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [
      routeKey('GET', '/v1/receipts/:receiptId'),
      [SAVIA_SCOPES.TRANSACTIONS_READ],
    ],
    [
      routeKey('GET', '/v1/reconciliations/:reconciliationId'),
      [SAVIA_SCOPES.TRANSACTIONS_READ],
    ],
    [routeKey('GET', '/v1/recurring-rules'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [routeKey('GET', '/v1/report-definitions'), [SAVIA_SCOPES.REPORTS_READ]],
    [
      routeKey('GET', '/v1/report-runs/:reportRunId'),
      [SAVIA_SCOPES.REPORTS_READ],
    ],
    [routeKey('GET', '/v1/scenarios'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('GET', '/v1/subscriptions'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [routeKey('GET', '/v1/tags'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [routeKey('GET', '/v1/transactions'), [SAVIA_SCOPES.TRANSACTIONS_READ]],
    [
      routeKey('GET', '/v1/transactions/:transactionId'),
      [SAVIA_SCOPES.TRANSACTIONS_READ],
    ],
    [routeKey('GET', '/v1/workspaces'), []],
    [routeKey('GET', '/v1/workspaces/:workspaceId'), []],
    [
      routeKey('GET', '/v1/workspaces/:workspaceId/invitations'),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [
      routeKey('GET', '/v1/workspaces/:workspaceId/members'),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [
      routeKey('PATCH', '/v1/accounts/:accountId'),
      [SAVIA_SCOPES.ACCOUNTS_WRITE],
    ],
    [routeKey('PATCH', '/v1/budgets/:budgetId'), [SAVIA_SCOPES.BUDGETS_WRITE]],
    [
      routeKey('PATCH', '/v1/transactions/:transactionId'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [
      routeKey('PATCH', '/v1/workspaces/:workspaceId'),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [
      routeKey('PATCH', '/v1/workspaces/:workspaceId/members/:memberId'),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [routeKey('POST', '/v1/accounts'), [SAVIA_SCOPES.ACCOUNTS_WRITE]],
    [
      routeKey('POST', '/v1/accounts/:accountId/close'),
      [SAVIA_SCOPES.ACCOUNTS_WRITE],
    ],
    [routeKey('POST', '/v1/budgets'), [SAVIA_SCOPES.BUDGETS_WRITE]],
    [routeKey('POST', '/v1/categories'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [
      routeKey('POST', '/v1/currency-exchanges'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [routeKey('POST', '/v1/debts'), [SAVIA_SCOPES.BUDGETS_WRITE]],
    [
      routeKey('POST', '/v1/debts/:debtId/payments'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE, SAVIA_SCOPES.BUDGETS_WRITE],
    ],
    [routeKey('POST', '/v1/exchange-rates'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [routeKey('POST', '/v1/export-jobs'), [SAVIA_SCOPES.REPORTS_WRITE]],
    [routeKey('POST', '/v1/forecasts/balance'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('POST', '/v1/funds'), [SAVIA_SCOPES.BUDGETS_WRITE]],
    [
      routeKey('POST', '/v1/funds/:fundId/contributions'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE, SAVIA_SCOPES.BUDGETS_WRITE],
    ],
    [routeKey('POST', '/v1/import-jobs'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [
      routeKey('POST', '/v1/import-jobs/:importJobId/commit'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [
      routeKey('POST', '/v1/import-jobs/:importJobId/rollback'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [routeKey('POST', '/v1/notifications/:notificationId/read'), []],
    [routeKey('POST', '/v1/payees'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [routeKey('POST', '/v1/receipts'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [
      routeKey('POST', '/v1/receipts/:receiptId/confirm'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [
      routeKey('POST', '/v1/reconciliations'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [
      routeKey('POST', '/v1/reconciliations/:reconciliationId/complete'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [
      routeKey('POST', '/v1/recurring-rules'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [routeKey('POST', '/v1/report-definitions'), [SAVIA_SCOPES.REPORTS_WRITE]],
    [routeKey('POST', '/v1/report-runs'), [SAVIA_SCOPES.REPORTS_READ]],
    [routeKey('POST', '/v1/scenarios'), [SAVIA_SCOPES.REPORTS_WRITE]],
    [
      routeKey('POST', '/v1/scenarios/:scenarioId/runs'),
      [SAVIA_SCOPES.REPORTS_READ],
    ],
    [routeKey('POST', '/v1/tags'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [routeKey('POST', '/v1/transactions'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [
      routeKey('POST', '/v1/transactions/:transactionId/void'),
      [SAVIA_SCOPES.TRANSACTIONS_WRITE],
    ],
    [routeKey('POST', '/v1/transfers'), [SAVIA_SCOPES.TRANSACTIONS_WRITE]],
    [
      routeKey('POST', '/v1/workspaces/:workspaceId/invitations'),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [
      routeKey(
        'POST',
        '/v1/workspaces/:workspaceId/invitations/:invitationId/revoke',
      ),
      [SAVIA_SCOPES.WORKSPACE_ADMIN],
    ],
    [
      routeKey('PUT', '/v1/budgets/:budgetId/allocations'),
      [SAVIA_SCOPES.BUDGETS_WRITE],
    ],
  ]);

export function routeKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}
