import type {
  ApprovalExecutor,
  McpApprovalValidation,
} from './approvals/approval.port.js';
import type { ApprovalService } from './approvals/approval.service.js';
import type { McpGrantAuthorizer, McpGrantCall } from './mcp/mcp-grant.port.js';
import type { McpProposalsPort } from './mcp/mcp-proposals.controller.js';
import { MCP_TOOL_ANNOTATIONS } from './mcp/mcp-tools.js';
import type { TransactionClient } from './platform/pg-transaction.js';

type Footprint = Pick<McpGrantCall, 'accountIds' | 'amounts'>;
type Validate<Command> = (
  client: TransactionClient,
  workspaceId: string,
  command: Command,
) => Promise<McpApprovalValidation>;

export interface McpWrite {
  name: string;
  execute: ApprovalExecutor;
  propose(requests: ApprovalService): McpProposalsPort;
}

export function defineMcpWrite<Command extends object>(
  name: string,
  grants: McpGrantAuthorizer,
  operations: {
    parse(args: Record<string, unknown>, stored: boolean): Command | undefined;
    footprint(
      command: Command,
      client: TransactionClient,
      workspaceId: string,
    ): Footprint | Promise<Footprint>;
    preview?(command: Command): Record<string, unknown>;
    snapshot?(
      command: Command,
      args: Record<string, unknown>,
    ): Record<string, unknown>;
    validate: Validate<Command>;
    apply(
      client: TransactionClient,
      subject: string,
      workspaceId: string,
      command: Command,
      key: string,
    ): Promise<{ kind: string }>;
  },
): McpWrite {
  const tool = MCP_TOOL_ANNOTATIONS.get(name);
  if (!tool?.requiresApproval || tool.riskClass === 'read') {
    throw new Error(`MCP write lacks an approval annotation: ${name}`);
  }
  const authorize = async (
    client: TransactionClient,
    subject: string,
    grantId: string,
    workspaceId: string,
    command: Command,
  ) =>
    grants.authorizeMcpGrant(client, {
      subject,
      grantId,
      workspaceId,
      toolName: name,
      ...(await operations.footprint(command, client, workspaceId)),
    });
  const riskClass = tool.riskClass;
  return {
    name,
    propose: (requests) => async (identity, workspaceId, _tool, args, key) => {
      const command = operations.parse(args, false);
      if (!command) return { kind: 'invalid' };
      const preview = { action: name, workspaceId };
      return requests.createMcpProposal(
        identity.subject,
        workspaceId,
        {
          toolName: name,
          grantId: identity.grantId,
          riskClass,
          arguments: args,
          preview,
        },
        key,
        (client) =>
          authorize(
            client,
            identity.subject,
            identity.grantId,
            workspaceId,
            command,
          ),
        async (client) => {
          const result = await operations.validate(
            client,
            workspaceId,
            command,
          );
          if (result === 'ok') {
            Object.assign(preview, operations.preview?.(command) ?? command, {
              action: name,
              workspaceId,
            });
          }
          return result;
        },
        operations.snapshot && (() => operations.snapshot!(command, args)),
      );
    },
    execute: async (
      client,
      subject,
      workspaceId,
      approvalId,
      args,
      grantId,
    ) => {
      if (!grantId) return 'invalid_action';
      const command = operations.parse(args, true);
      if (!command) return 'invalid_action';
      if (!(await authorize(client, subject, grantId, workspaceId, command)))
        return 'forbidden';
      const { kind } = await operations.apply(
        client,
        subject,
        workspaceId,
        command,
        `mcp:${approvalId}`,
      );
      if (kind === 'created' || kind === 'updated' || kind === 'ok')
        return 'ok';
      if (kind === 'precondition-failed') return 'precondition_failed';
      if (kind === 'forbidden') return 'forbidden';
      if (
        kind === 'replayed' ||
        kind === 'conflict' ||
        kind === 'idempotency_conflict'
      )
        return 'conflict';
      return 'invalid_action';
    },
  };
}
