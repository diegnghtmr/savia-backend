import {
  TRANSACTION_TYPE,
  type CreateTransactionCommand,
  type CreateTransferCommand,
} from '../platform/ledger-writer.port.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type {
  AgentProviderContext,
  AgentToolCall,
  AgentToolDefinition,
} from './agent-message.port.js';

export const CREATE_TRANSACTION_TOOL = 'create_transaction';
export const CREATE_TRANSFER_TOOL = 'create_transfer';
type WriteToolName =
  | typeof CREATE_TRANSACTION_TOOL
  | typeof CREATE_TRANSFER_TOOL;
export const AGENT_TOOL_PORTS = Symbol('AgentToolPorts');
export const AGENT_TOOL_PAGE_LIMIT = 20;
const approvalLifetimeMs = 15 * 60_000;

export interface AgentApprovalProposal {
  readonly toolName: WriteToolName;
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
  validateTransfer(input: unknown): CreateTransferCommand | null;
  canUseAccount(
    context: AgentProviderContext,
    accountId: string,
  ): Promise<boolean>;
  createApproval(
    context: AgentProviderContext,
    proposal: AgentApprovalProposal,
  ): Promise<string | undefined>;
}

type ObjectSchema = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Schema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
};
// Closed subset of JSON Schema used by the registry. Each keyword has exactly
// one interpretation here and in the schema advertised to the provider.
type Schema =
  | ObjectSchema
  | {
      readonly type: 'array';
      readonly items: StringSchema;
      readonly uniqueItems: true;
    }
  | StringSchema;
type StringSchema = {
  readonly type: 'string' | readonly ['string', 'null'];
  readonly enum?: readonly string[];
  readonly format?: 'uuid' | 'date-time';
  readonly pattern?: string;
  readonly maxLength?: number;
};

function matches(schema: Schema, value: unknown): boolean {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    return (
      schema.required.every((key) => Object.hasOwn(value, key)) &&
      Object.entries(value).every(
        ([key, entry]) =>
          Object.hasOwn(schema.properties, key) &&
          matches(schema.properties[key], entry),
      )
    );
  }
  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      value.every((entry: unknown) => matches(schema.items, entry)) &&
      new Set(value).size === value.length
    );
  }
  if (value === null) return schema.type !== 'string';
  if (typeof value !== 'string') return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
    return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.format === 'uuid') return UUID_PATTERN.test(value);
  if (schema.format === 'date-time') {
    const day =
      /^\d{4}-\d{2}-\d{2}(?=T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/i.exec(
        value,
      )?.[0];
    if (!day || !Number.isFinite(Date.parse(value))) return false;
    const midnight = new Date(`${day}T00:00:00Z`);
    return (
      Number.isFinite(midnight.getTime()) &&
      midnight.toISOString().startsWith(day)
    );
  }
  return true;
}

type ToolResult =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'error'; readonly value: { readonly error: string } }
  | { readonly kind: 'approval'; readonly approvalId: string };
type Tool = AgentToolDefinition & {
  readonly parameters: ObjectSchema;
  readonly requiresApproval: boolean;
  execute(
    ports: AgentToolPorts,
    context: AgentProviderContext,
    args: AgentToolCall['arguments'],
    signal: AbortSignal,
  ): Promise<ToolResult>;
};
const error = (message: string): ToolResult => ({
  kind: 'error',
  value: { error: message },
});
const object = (
  properties: ObjectSchema['properties'],
  required: readonly string[] = [],
): ObjectSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const uuid = { type: 'string', format: 'uuid' } as const;
const nullableUuid = { type: ['string', 'null'], format: 'uuid' } as const;
const description = { type: ['string', 'null'], maxLength: 500 } as const;
const date = { type: 'string', format: 'date-time' } as const;
const money = object(
  {
    amountMinor: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  },
  ['amountMinor', 'currency'],
);

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
    execute: async (ports, context) => {
      const value = await ports[read](context);
      return value === undefined
        ? error('Workspace access forbidden')
        : { kind: 'result', value };
    },
  };
}

function writeTool<T extends CreateTransactionCommand | CreateTransferCommand>(
  toolName: WriteToolName,
  description: string,
  parameters: ObjectSchema,
  validate: (ports: AgentToolPorts, input: unknown) => T | null,
  accountIds: (command: T) => readonly string[],
  preview: (command: T) => Record<string, unknown>,
): Tool {
  return {
    name: toolName,
    description,
    parameters,
    requiresApproval: true,
    execute: async (ports, context, args, signal) => {
      const command = validate(ports, args);
      if (!command) return error('Invalid tool arguments');
      for (const id of accountIds(command)) {
        signal.throwIfAborted();
        if (!(await ports.canUseAccount(context, id)))
          return error('Account was not found in the workspace');
      }
      signal.throwIfAborted();
      const approvalId = await ports.createApproval(context, {
        toolName,
        channel: 'agent',
        riskClass: 'financial_write', // x-savia-mcp-tool for both writes.
        arguments: { ...command },
        preview: {
          action: toolName,
          workspaceId: context.workspaceId,
          amount: command.amount.amountMinor,
          currency: command.amount.currency,
          date: command.occurredAt,
          rate: null,
          fee: null,
          categoryId: null,
          ...preview(command),
        },
        expiresAt: new Date(Date.now() + approvalLifetimeMs),
      });
      return approvalId
        ? { kind: 'approval', approvalId }
        : error('Approval could not be created');
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
  writeTool(
    CREATE_TRANSACTION_TOOL,
    'Propose a transaction for explicit approval; does not write to the ledger',
    object(
      {
        type: { type: 'string', enum: Object.values(TRANSACTION_TYPE) },
        accountId: uuid,
        amount: money,
        occurredAt: date,
        status: { type: 'string', enum: ['draft', 'pending', 'confirmed'] },
        categoryId: nullableUuid,
        payeeId: nullableUuid,
        description,
        notes: { type: ['string', 'null'], maxLength: 2000 },
        tagIds: { type: 'array', items: uuid, uniqueItems: true },
        receiptId: nullableUuid,
      },
      ['type', 'accountId', 'amount', 'occurredAt'],
    ),
    (ports, args) => ports.validateTransaction(args),
    (command) => [command.accountId],
    (command) => ({
      accountId: command.accountId,
      categoryId: command.categoryId ?? null,
      consequences:
        'Creates a transaction with the previewed status after confirmation.',
    }),
  ),
  writeTool(
    CREATE_TRANSFER_TOOL,
    'Propose a same-currency transfer for explicit approval; does not write to the ledger',
    object(
      {
        sourceAccountId: uuid,
        destinationAccountId: uuid,
        amount: money,
        occurredAt: date,
      },
      ['sourceAccountId', 'destinationAccountId', 'amount', 'occurredAt'],
    ),
    (ports, args) => ports.validateTransfer(args),
    (command) => [command.sourceAccountId, command.destinationAccountId],
    (command) => ({
      sourceAccountId: command.sourceAccountId,
      destinationAccountId: command.destinationAccountId,
      // The ledger records neither a transfer fee nor a description, so the tool accepts neither.
      consequences:
        'Moves the amount from the source to the destination after confirmation.',
    }),
  ),
];

export const agentToolDefinitions: readonly AgentToolDefinition[] = tools.map(
  ({ name, description, parameters }) => ({ name, description, parameters }),
);
export const agentToolRegistry: ReadonlyMap<string, Tool> = new Map(
  tools.map((tool) => [
    tool.name,
    {
      ...tool,
      execute: (ports, context, args, signal) =>
        matches(tool.parameters, args)
          ? tool.execute(ports, context, args, signal)
          : Promise.resolve(error('Invalid tool arguments')),
    },
  ]),
);
