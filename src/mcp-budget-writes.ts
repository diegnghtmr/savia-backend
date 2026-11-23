import {
  BudgetCommandValidationError,
  createBudgetCommand,
  updateBudgetAllocationsCommand,
  updateBudgetCommand,
} from './budgets/budget-command.js';
import type {
  Budget,
  CreateBudgetRequest,
  UpdateBudgetAllocationsRequest,
  UpdateBudgetRequest,
} from './budgets/budget.port.js';
import type {
  BudgetCreateSnapshot,
  BudgetService,
} from './budgets/budget.service.js';
import { defineMcpWrite } from './mcp-write.js';
import type { McpGrantAuthorizer, Money } from './mcp/mcp-grant.port.js';
import { parseIfMatch, type IfMatchParse } from './platform/if-match.js';
import { UUID_PATTERN } from './platform/uuid.js';

interface BudgetCreation {
  body: CreateBudgetRequest;
  snapshot?: BudgetCreateSnapshot;
  currency?: string;
  source?: Budget;
  amounts?: readonly Money[];
}

interface BudgetMutation<T> {
  budgetId: string;
  match: Extract<IfMatchParse, { kind: 'versions' }>;
  body: T;
  current?: Budget;
  amounts?: readonly Money[];
}

// Only confirmation parses this field from the immutable, hash-bound snapshot.
function isMoneyList(value: unknown): value is readonly Money[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (money: unknown) =>
        money !== null &&
        typeof money === 'object' &&
        'currency' in money &&
        typeof money.currency === 'string' &&
        'amountMinor' in money &&
        typeof money.amountMinor === 'string',
    )
  );
}

function parseCreation(
  args: Record<string, unknown>,
  stored: boolean,
): BudgetCreation | undefined {
  if (!stored) return { body: createBudgetCommand(args) };
  const { body, currency, sourceVersion, amounts } = args;
  if (
    typeof currency !== 'string' ||
    (sourceVersion !== undefined && typeof sourceVersion !== 'number') ||
    !isMoneyList(amounts)
  )
    return undefined;
  return {
    body: createBudgetCommand(body),
    snapshot: { currency, sourceVersion },
    amounts,
  };
}

function parseMutation<T>(
  args: Record<string, unknown>,
  parseBody: (body: unknown) => T,
): BudgetMutation<T> | undefined {
  const { budgetId, ifMatch, body } = args;
  if (
    Object.keys(args).length !== 3 ||
    typeof budgetId !== 'string' ||
    !UUID_PATTERN.test(budgetId) ||
    typeof ifMatch !== 'string'
  )
    return undefined;
  const match = parseIfMatch(ifMatch);
  if (match.kind !== 'versions' || match.versions.length !== 1)
    return undefined;
  return { budgetId: budgetId.toLowerCase(), match, body: parseBody(body) };
}

function parseAllocations(
  args: Record<string, unknown>,
  stored: boolean,
): BudgetMutation<UpdateBudgetAllocationsRequest> | undefined {
  const { input, amounts } = args;
  if (stored && (!isRecord(input) || !isMoneyList(amounts))) return undefined;
  const command = parseMutation(
    stored && isRecord(input) ? input : args,
    updateBudgetAllocationsCommand,
  );
  if (!command) return undefined;
  const allocations = command.body.allocations.map((allocation) => ({
    ...allocation,
    categoryId: allocation.categoryId.toLowerCase(),
    rolloverTargetId: allocation.rolloverTargetId?.toLowerCase() ?? null,
    planned: {
      ...allocation.planned,
      amountMinor: BigInt(allocation.planned.amountMinor).toString(),
    },
  }));
  if (
    new Set(allocations.map(({ categoryId }) => categoryId)).size !==
    allocations.length
  )
    return undefined;
  return {
    ...command,
    body: { allocations },
    amounts: stored && isMoneyList(amounts) ? amounts : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function budgetParser<T>(
  parse: (args: Record<string, unknown>, stored: boolean) => T,
) {
  return (args: Record<string, unknown>, stored: boolean) => {
    try {
      return parse(args, stored);
    } catch (error) {
      if (error instanceof BudgetCommandValidationError) return undefined;
      throw error;
    }
  };
}

function monetaryFootprint(
  currency: string | undefined,
  amounts: readonly Money[] = [],
) {
  return {
    // Budget metadata and planning values do not move funds in accounts.
    accountIds: [],
    amounts: amounts.length
      ? amounts
      : currency
        ? [{ amountMinor: '0', currency }]
        : [],
  };
}

function mutationPreview<T>({
  budgetId,
  match,
  body,
  current,
}: BudgetMutation<T>) {
  return {
    budgetId,
    ifMatch: `"${match.versions[0]}"`,
    body,
    currency: current?.currency,
  };
}

export function mcpBudgetWrites(
  budgets: BudgetService,
  grants: McpGrantAuthorizer,
) {
  return [
    defineMcpWrite<BudgetCreation>('create_budget', grants, {
      parse: budgetParser(parseCreation),
      footprint: async (command, client, workspaceId) => {
        // Reauthorize exactly what was approved. The writer separately checks
        // the workspace currency and copy-source version before copying.
        if (command.amounts)
          return monetaryFootprint(undefined, command.amounts);
        command.currency = await budgets.readCurrencyWithin(
          client,
          workspaceId,
        );
        command.source = command.body.copyFromBudgetId
          ? await budgets.findWithin(
              client,
              workspaceId,
              command.body.copyFromBudgetId,
            )
          : undefined;
        const footprint = monetaryFootprint(
          command.currency,
          command.source?.allocations.map(({ planned }) => ({
            ...planned,
            currency: command.currency ?? planned.currency,
          })),
        );
        command.amounts = footprint.amounts;
        return footprint;
      },
      validate: async (client, workspaceId, command) => {
        const currency = await budgets.readCurrencyWithin(client, workspaceId);
        if (command.currency !== currency) return 'invalid';
        if (command.source) {
          const source = await budgets.findWithin(
            client,
            workspaceId,
            command.source.id,
          );
          if (command.source.version !== source?.version) return 'invalid';
        }
        const allowed = await budgets.canCreateWithin(
          client,
          workspaceId,
          command.body,
          currency,
          command.source,
        );
        return allowed ? 'ok' : 'invalid';
      },
      preview: ({ body, currency, source }) => ({
        ...body,
        currency,
        ...(source
          ? {
              sourceVersion: source.version,
              allocations: source.allocations.map(
                ({
                  categoryId,
                  planned,
                  rolloverPolicy,
                  rolloverTargetId,
                }) => ({
                  categoryId,
                  planned: { ...planned, currency },
                  rolloverPolicy,
                  rolloverTargetId,
                }),
              ),
            }
          : {}),
      }),
      snapshot: (command, args) => ({
        body: args,
        currency: command.currency,
        sourceVersion: command.source?.version,
        amounts: command.amounts,
      }),
      apply: (client, subject, workspaceId, command, key) =>
        budgets.createBudget(
          subject,
          workspaceId,
          command.body,
          key,
          client,
          command.snapshot,
        ),
    }),
    defineMcpWrite<BudgetMutation<UpdateBudgetRequest>>(
      'update_budget',
      grants,
      {
        parse: budgetParser((args) => parseMutation(args, updateBudgetCommand)),
        footprint: async (command, client, workspaceId) => {
          command.current = await budgets.findWithin(
            client,
            workspaceId,
            command.budgetId,
          );
          return monetaryFootprint(command.current?.currency);
        },
        preview: mutationPreview,
        validate: async (_client, _workspaceId, { current, match }) =>
          current?.version === match.versions[0] ? 'ok' : 'invalid',
        apply: (client, subject, workspaceId, command, key) =>
          budgets.updateBudget(
            subject,
            workspaceId,
            command.budgetId,
            command.body,
            key,
            command.match,
            client,
          ),
      },
    ),
    defineMcpWrite<BudgetMutation<UpdateBudgetAllocationsRequest>>(
      'update_budget_allocations',
      grants,
      {
        parse: budgetParser(parseAllocations),
        footprint: async (command, client, workspaceId) => {
          if (command.amounts)
            return monetaryFootprint(undefined, command.amounts);
          command.current = await budgets.findWithin(
            client,
            workspaceId,
            command.budgetId,
          );
          if (!command.current) return monetaryFootprint(undefined);
          const { currency, allocations } = command.current;
          const previous = new Map(
            allocations.map(({ categoryId, planned }) => [
              categoryId,
              BigInt(planned.amountMinor),
            ]),
          );
          const amounts = command.body.allocations.map(
            ({ categoryId, planned }) => {
              const delta =
                BigInt(planned.amountMinor) - (previous.get(categoryId) ?? 0n);
              previous.delete(categoryId);
              return { currency, amountMinor: delta.toString() };
            },
          );
          for (const amount of previous.values()) {
            amounts.push({ currency, amountMinor: (-amount).toString() });
          }
          const footprint = monetaryFootprint(currency, amounts);
          command.amounts = footprint.amounts;
          return footprint;
        },
        preview: mutationPreview,
        snapshot: ({ amounts }, input) => ({ input, amounts }),
        validate: async (client, workspaceId, { current, match, body }) => {
          if (!current || current.version !== match.versions[0])
            return 'invalid';
          const allowed = await budgets.validateAllocationsWithin(
            client,
            workspaceId,
            body,
            current.currency,
          );
          return allowed ? 'ok' : 'invalid';
        },
        apply: (client, subject, workspaceId, command, key) =>
          budgets.updateBudgetAllocations(
            subject,
            workspaceId,
            command.budgetId,
            command.body,
            key,
            command.match,
            client,
          ),
      },
    ),
  ];
}
