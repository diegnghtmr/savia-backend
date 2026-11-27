import type { McpReadAdmission } from '../platform/mcp-read-auth.js';
import type { PgTransaction } from '../platform/pg-transaction.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { parseWorkspaceHeader } from '../platform/workspace-header.js';
import { MCP_TOOL_ANNOTATIONS } from './mcp-tools.js';
import type { PostgresMcpGrantAdapter } from './postgres-mcp-grant.adapter.js';

function accountField(value: unknown): unknown {
  return value && typeof value === 'object' && 'accountId' in value
    ? value.accountId
    : undefined;
}

export function mcpReadAdmission(
  tx: PgTransaction,
  grants: PostgresMcpGrantAdapter,
): McpReadAdmission {
  return async (identity, { toolName, resource }, request) => {
    const annotation = MCP_TOOL_ANNOTATIONS.get(toolName);
    if (annotation?.riskClass !== 'read' || annotation.requiresApproval)
      return undefined;
    if (resource === 'workspace-list') {
      if (annotation.requiredScopes.length) return undefined;
      return tx.runRead(identity.subject, (client) =>
        grants.readDiscoveryWorkspaces(client, identity, toolName),
      );
    }
    const header = parseWorkspaceHeader(request.headers['x-workspace-id']);
    if (header.kind !== 'ok') return undefined;
    const account =
      resource === 'account-path'
        ? accountField(request.params)
        : resource === 'account-query'
          ? accountField(request.query)
          : undefined;
    if (
      (resource === 'account-path' || account !== undefined) &&
      (typeof account !== 'string' || !UUID_PATTERN.test(account))
    )
      return undefined;
    const { workspaceId } = header;
    const allowed = await tx.run(identity.subject, (client) =>
      grants.authorizeMcpGrant(client, {
        ...identity,
        workspaceId,
        toolName,
        accountIds: typeof account === 'string' ? [account] : [],
        amounts: [],
      }),
    );
    return allowed ? [workspaceId] : undefined;
  };
}
