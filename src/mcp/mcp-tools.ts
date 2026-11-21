import type { SaviaScope } from '../platform/savia-scopes.js';

export interface McpToolAnnotation {
  readonly riskClass:
    | 'read'
    | 'low_risk_write'
    | 'financial_write'
    | 'destructive'
    | 'administrative';
  readonly requiresApproval: boolean;
  readonly requiredScopes: readonly SaviaScope[];
}

// Snapshot of x-savia-mcp-tool in the c4135ab planning authority. The authority
// parity suite checks every entry. Neither callers nor approvals supply scopes.
const annotations = new Map<string, McpToolAnnotation>();

function register(
  names: readonly string[],
  riskClass: McpToolAnnotation['riskClass'],
  ...requiredScopes: SaviaScope[]
): void {
  for (const name of names) {
    annotations.set(name, {
      riskClass,
      requiresApproval: riskClass !== 'read',
      requiredScopes,
    });
  }
}

register(['list_workspaces'], 'read');
register(['list_accounts', 'get_account_balance'], 'read', 'accounts:read');
register(['search_transactions'], 'read', 'transactions:read');
register(['get_budget_status'], 'read', 'budgets:read');
register(
  [
    'get_financial_summary',
    'create_forecast',
    'get_forecast',
    'run_scenario',
    'run_report',
    'export_report_pdf',
  ],
  'read',
  'reports:read',
);
register(['list_ai_providers'], 'read', 'workspace:admin');
register(['create_account'], 'administrative', 'accounts:write');
register(
  [
    'create_transaction',
    'update_transaction',
    'create_transfer',
    'create_cross_currency_transfer',
  ],
  'financial_write',
  'transactions:write',
);
register(['void_transaction'], 'destructive', 'transactions:write');
register(
  [
    'create_budget',
    'update_budget',
    'update_budget_allocations',
    'create_sinking_fund',
  ],
  'low_risk_write',
  'budgets:write',
);
register(
  ['contribute_to_fund'],
  'financial_write',
  'transactions:write',
  'budgets:write',
);
register(['scan_receipt'], 'low_risk_write', 'transactions:write');
register(['create_report_definition'], 'low_risk_write', 'reports:write');

export const MCP_TOOL_ANNOTATIONS: ReadonlyMap<string, McpToolAnnotation> =
  annotations;
