import type { SaviaScope } from './savia-scopes.js';

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

// The original tool catalog is also used by the grant and approval services
// when they run independently of the HTTP API. Read routes may extend it by
// declaration, but cannot change an existing tool's risk class or scopes.
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
register(
  ['get_budget_status', 'get_debt_projection', 'get_sinking_fund'],
  'read',
  'budgets:read',
);
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
    'update_sinking_fund',
  ],
  'low_risk_write',
  'budgets:write',
);
register(
  ['contribute_to_fund', 'withdraw_from_fund'],
  'financial_write',
  'transactions:write',
  'budgets:write',
);
register(['scan_receipt'], 'low_risk_write', 'transactions:write');
register(['create_report_definition'], 'low_risk_write', 'reports:write');

export const MCP_TOOL_ANNOTATIONS: ReadonlyMap<string, McpToolAnnotation> =
  annotations;

export function registerMcpRead(
  toolName: string,
  scopes: readonly SaviaScope[],
): void {
  const existing = annotations.get(toolName);
  if (!existing) {
    register([toolName], 'read', ...scopes);
    return;
  }
  if (
    existing.riskClass !== 'read' ||
    existing.requiresApproval ||
    existing.requiredScopes.length !== scopes.length ||
    existing.requiredScopes.some((scope, index) => scope !== scopes[index])
  ) {
    throw new Error(`Conflicting MCP declaration for ${toolName}`);
  }
}
