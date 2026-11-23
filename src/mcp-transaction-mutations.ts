import type { ApprovalExecutor } from './approvals/approval.port.js';
import type { ApprovalService } from './approvals/approval.service.js';
import type { Transaction } from './ledger/ledger.port.js';
import {
  createUpdateTransactionCommand,
  createVoidTransactionCommand,
  TransactionCommandValidationError,
} from './ledger/transaction-command.js';
import { TransactionSplitsUnsupportedError } from './ledger/splits-guard.js';
import type { TransactionService } from './ledger/transaction.service.js';
import type { McpGrantAuthorizer } from './mcp/mcp-grant.port.js';
import { MCP_TOOL_ANNOTATIONS } from './mcp/mcp-tools.js';
import { parseIfMatch } from './platform/if-match.js';
import type { TransactionClient } from './platform/pg-transaction.js';
import type { McpProposalIdentity } from './platform/request-identity.js';
import { UUID_PATTERN } from './platform/uuid.js';

export const TRANSACTION_MUTATIONS = [
  'update_transaction',
  'void_transaction',
] as const;
type Tool = (typeof TRANSACTION_MUTATIONS)[number];

export function isTransactionMutation(tool: string): tool is Tool {
  return tool === 'update_transaction' || tool === 'void_transaction';
}

function parse(tool: Tool, args: Record<string, unknown>) {
  const { transactionId, ifMatch, body } = args;
  if (
    Object.keys(args).length !== 3 ||
    typeof transactionId !== 'string' ||
    !UUID_PATTERN.test(transactionId) ||
    typeof ifMatch !== 'string'
  )
    return undefined;
  const match = parseIfMatch(ifMatch);
  if (match.kind !== 'versions' || match.versions.length !== 1)
    return undefined;
  const version = match.versions[0];
  const target = {
    transactionId: transactionId.toLowerCase(),
    ifMatch: `"${version}"`,
  };
  try {
    return tool === 'update_transaction'
      ? {
          tool,
          version,
          snapshot: { ...target, body: createUpdateTransactionCommand(body) },
        }
      : {
          tool,
          version,
          snapshot: { ...target, body: createVoidTransactionCommand(body) },
        };
  } catch (error) {
    if (
      error instanceof TransactionCommandValidationError ||
      error instanceof TransactionSplitsUnsupportedError
    )
      return undefined;
    throw error;
  }
}

async function authorize(
  grants: McpGrantAuthorizer,
  client: TransactionClient,
  identity: McpProposalIdentity,
  workspaceId: string,
  toolName: Tool,
  current: Transaction | undefined,
): Promise<boolean> {
  // An unresolved or cross-workspace target has no authorizable footprint.
  return grants.authorizeMcpGrant(client, {
    ...identity,
    workspaceId,
    toolName,
    accountIds: current ? [current.accountId] : [],
    amounts: current ? [current.amount] : [],
  });
}

export async function proposeTransactionMutation(
  requests: ApprovalService,
  transactions: TransactionService,
  grants: McpGrantAuthorizer,
  identity: McpProposalIdentity,
  workspaceId: string,
  tool: Tool,
  args: Record<string, unknown>,
  key: string,
) {
  const parsed = parse(tool, args);
  const toolMetadata = MCP_TOOL_ANNOTATIONS.get(tool);
  if (!parsed || !toolMetadata || toolMetadata.riskClass === 'read')
    return { kind: 'invalid' } as const;
  let current: Transaction | undefined;
  // Keep the preview independent of mutable grant metadata. The version pins
  // the snapshot and ledger footprint presented to the confirming user.
  const preview: Record<string, unknown> = {
    ...parsed.snapshot,
    action: tool,
    workspaceId,
  };
  return requests.createMcpProposal(
    identity.subject,
    workspaceId,
    {
      toolName: tool,
      grantId: identity.grantId,
      riskClass: toolMetadata.riskClass,
      arguments: parsed.snapshot,
      preview,
    },
    key,
    async (client, stored) => {
      // Mutations resolved the account from a live row at creation; replay
      // uses the account in that stored preview, not the current transaction.
      const preview =
        stored && typeof stored === 'object' && 'preview' in stored
          ? stored.preview
          : undefined;
      if (
        !preview ||
        typeof preview !== 'object' ||
        !('accountId' in preview) ||
        typeof preview.accountId !== 'string'
      )
        return false;
      return grants.authorizeMcpProposalReplay(client, {
        ...identity,
        workspaceId,
        toolName: tool,
        accountIds: [preview.accountId],
      });
    },
    async (client) => {
      current = await transactions.readWithin(
        client,
        workspaceId,
        parsed.snapshot.transactionId,
      );
      return authorize(grants, client, identity, workspaceId, tool, current);
    },
    async (client) => {
      if (
        !current ||
        current.version !== parsed.version ||
        current.status === 'voided' ||
        current.status === 'reconciled' ||
        (tool === 'void_transaction' && current.status === 'draft')
      )
        return 'invalid';
      if (
        parsed.tool === 'update_transaction' &&
        !(await transactions.preflightUpdateFields(
          client,
          workspaceId,
          parsed.snapshot.body,
        ))
      )
        return 'invalid';
      preview.accountId = current.accountId;
      preview.amount = current.amount;
      preview.status = current.status;
      return 'ok';
    },
  );
}

export function transactionMutationExecutor(
  tool: Tool,
  transactions: TransactionService,
  grants: McpGrantAuthorizer,
): ApprovalExecutor {
  return async (client, subject, workspaceId, approvalId, args, grantId) => {
    if (!grantId) return 'invalid_action';
    const parsed = parse(tool, args);
    if (!parsed) return 'invalid_action';
    const { transactionId } = parsed.snapshot;
    const current = await transactions.readWithin(
      client,
      workspaceId,
      transactionId,
    );
    const authorized = await authorize(
      grants,
      client,
      { subject, grantId },
      workspaceId,
      tool,
      current,
    );
    if (!authorized) return 'forbidden';
    if (current?.version !== parsed.version) return 'precondition_failed';
    const key = `mcp:${approvalId}`;
    const outcome =
      parsed.tool === 'update_transaction'
        ? await transactions.update(
            subject,
            workspaceId,
            transactionId,
            parsed.snapshot.body,
            key,
            parsed.version,
            client,
          )
        : await transactions.void(
            subject,
            workspaceId,
            transactionId,
            parsed.snapshot.body,
            key,
            parsed.version,
            client,
          );
    if (outcome.kind === 'ok') return 'ok';
    if (outcome.kind === 'forbidden') return 'forbidden';
    if (outcome.kind === 'idempotency_conflict' || outcome.kind === 'replayed')
      return 'conflict';
    const after = await transactions.readWithin(
      client,
      workspaceId,
      transactionId,
    );
    if (after && after.version !== parsed.version) return 'precondition_failed';
    return 'invalid_action';
  };
}
