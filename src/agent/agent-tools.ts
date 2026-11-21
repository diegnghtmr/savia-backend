import {
  TRANSACTION_TYPE,
  type CreateTransactionCommand,
} from '../platform/ledger-writer.port.js';
import type {
  AgentProviderContext,
  AgentToolCall,
  AgentToolDefinition,
} from './agent-message.port.js';

export const CREATE_TRANSACTION_TOOL = 'create_transaction';
export const AGENT_TOOL_PORTS = Symbol('AgentToolPorts');
export const AGENT_TOOL_PAGE_LIMIT = 20;
const approvalLifetimeMs = 15 * 60_000;

export interface AgentApprovalProposal {
  readonly toolName: typeof CREATE_TRANSACTION_TOOL;
  readonly channel: 'agent';
  readonly riskClass: 'financial_write';
  readonly arguments: Record<string, unknown>;
  readonly preview: Record<string, unknown>;
  readonly expiresAt: Date;
}
export interface AgentToolPorts {
  listAccounts(context: AgentProviderContext): Promise<unknown>;
  listRecentTransactions(context: AgentProviderContext): Promise<unknown>;
  validateTransaction(input: unknown): CreateTransactionCommand | null;
  canUseAccount(
    context: AgentProviderContext,
    accountId: string,
  ): Promise<boolean>;
  createApproval(
    context: AgentProviderContext,
    proposal: AgentApprovalProposal,
  ): Promise<string | undefined>;
}

type ToolResult =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'error'; readonly value: { readonly error: string } }
  | { readonly kind: 'approval'; readonly approvalId: string };
type Tool = AgentToolDefinition & {
  readonly requiresApproval: boolean;
  execute(
    ports: AgentToolPorts,
    context: AgentProviderContext,
    args: AgentToolCall['arguments'],
    signal: AbortSignal,
  ): Promise<ToolResult>;
};
const invalid: ToolResult = {
  kind: 'error',
  value: { error: 'Invalid tool arguments' },
};
const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
) => ({ type: 'object', properties, required, additionalProperties: false });
const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { type: ['string', 'null'], format: 'uuid' };

function readTool(
  name: string,
  description: string,
  read: 'listAccounts' | 'listRecentTransactions',
): Tool {
  return {
    name,
    description,
    parameters: object({}),
    requiresApproval: false,
    execute: async (ports, context, args) => {
      if (Object.keys(args).length) return invalid;
      const value = await ports[read](context);
      return value === undefined
        ? { kind: 'error', value: { error: 'Workspace access forbidden' } }
        : { kind: 'result', value };
    },
  };
}

const tools: readonly Tool[] = [
  readTool(
    'list_accounts',
    'List accounts in the active workspace',
    'listAccounts',
  ),
  readTool(
    'list_recent_transactions',
    'List recent transactions in the active workspace',
    'listRecentTransactions',
  ),
  {
    name: CREATE_TRANSACTION_TOOL,
    description:
      'Propose a transaction for explicit approval; does not write to the ledger',
    parameters: object(
      {
        type: { enum: Object.values(TRANSACTION_TYPE) },
        accountId: uuid,
        amount: object(
          {
            amountMinor: { type: 'string' },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
          ['amountMinor', 'currency'],
        ),
        occurredAt: { type: 'string', format: 'date-time' },
        status: { enum: ['draft', 'pending', 'confirmed'] },
        categoryId: nullableUuid,
        payeeId: nullableUuid,
        description: { type: ['string', 'null'], maxLength: 500 },
        notes: { type: ['string', 'null'], maxLength: 2000 },
        tagIds: { type: 'array', items: uuid, uniqueItems: true },
        receiptId: nullableUuid,
      },
      ['type', 'accountId', 'amount', 'occurredAt'],
    ),
    // OpenAPI createTransaction x-savia-mcp-tool.
    requiresApproval: true,
    execute: async (ports, context, args, signal) => {
      const command = ports.validateTransaction(args);
      if (!command) return invalid;
      if (!(await ports.canUseAccount(context, command.accountId)))
        return {
          kind: 'error',
          value: { error: 'Account was not found in the workspace' },
        };
      signal.throwIfAborted();
      const canonical = { ...command };
      const approvalId = await ports.createApproval(context, {
        toolName: CREATE_TRANSACTION_TOOL,
        channel: 'agent',
        riskClass: 'financial_write',
        arguments: canonical,
        preview: {
          action: CREATE_TRANSACTION_TOOL,
          workspaceId: context.workspaceId,
          accountId: command.accountId,
          amount: command.amount.amountMinor,
          currency: command.amount.currency,
          date: command.occurredAt,
          categoryId: command.categoryId ?? null,
          rate: null,
          fee: null,
          consequences:
            'Creates a transaction with the previewed status after confirmation.',
        },
        expiresAt: new Date(Date.now() + approvalLifetimeMs),
      });
      return approvalId
        ? { kind: 'approval', approvalId }
        : { kind: 'error', value: { error: 'Approval could not be created' } };
    },
  },
];

export const agentToolDefinitions: readonly AgentToolDefinition[] = tools.map(
  ({ name, description, parameters }) => ({ name, description, parameters }),
);
export const agentToolRegistry: ReadonlyMap<string, Tool> = new Map(
  tools.map((tool) => [tool.name, tool]),
);
