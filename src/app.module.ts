import { Module } from '@nestjs/common';

import { AccountsModule } from './accounts/accounts.module.js';
import { ACCOUNTS_PORT, type AccountsPort } from './accounts/accounts.port.js';
import { AccountsService } from './accounts/accounts.service.js';
import { CurrencyExchangeService } from './ledger/currency-exchange.service.js';
import { mcpAccountWrites } from './mcp-account-writes.js';
import { CatalogsModule } from './catalogs/catalogs.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import {
  LEDGER_PORT,
  TRANSACTION_CREATE_OUTCOMES,
  type LedgerPort,
} from './ledger/ledger.port.js';
import {
  createTransactionCommand,
  TransactionCommandValidationError,
} from './ledger/transaction-command.js';
import { TransactionSplitsUnsupportedError } from './ledger/splits-guard.js';
import { TransactionService } from './ledger/transaction.service.js';
import {
  createTransferCommand,
  TransferCommandValidationError,
} from './ledger/transfer-command.js';
import { TransferService } from './ledger/transfer.service.js';
import {
  LEDGER_WRITER,
  type CreateTransactionCommand,
  type CreateTransferCommand,
  type LedgerWriter,
} from './platform/ledger-writer.port.js';
import { PlatformModule } from './platform/platform.module.js';
import { RecurringModule } from './recurring/recurring.module.js';
import { ReconciliationsModule } from './reconciliations/reconciliations.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { BudgetService } from './budgets/budget.service.js';
import { mcpBudgetWrites } from './mcp-budget-writes.js';
import { FundsModule } from './funds/funds.module.js';
import { FundService } from './funds/fund.service.js';
import { mcpFundReportWrites } from './mcp-fund-report-writes.js';
import { DebtsModule } from './debts/debts.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { ScenariosModule } from './scenarios/scenarios.module.js';
import { ForecastsModule } from './forecasts/forecasts.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ReportService } from './reports/report.service.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import {
  APPROVALS_PORT,
  type ApprovalExecutor,
  type ApprovalsPort,
} from './approvals/approval.port.js';
import { ApprovalService } from './approvals/approval.service.js';
import type { TransactionClient } from './platform/pg-transaction.js';
import type { McpProposalIdentity } from './platform/request-identity.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ReceiptsModule } from './receipts/receipts.module.js';
import { McpGrantsModule } from './mcp/mcp-grants.module.js';
import { McpProposalsModule } from './mcp/mcp-proposals.module.js';
import { MCP_TOOL_ANNOTATIONS } from './mcp/mcp-tools.js';
import {
  isTransactionMutation,
  proposeTransactionMutation,
  transactionMutationExecutor,
  TRANSACTION_MUTATIONS,
} from './mcp-transaction-mutations.js';
import type { McpGrantAuthorizer } from './mcp/mcp-grant.port.js';
import { PostgresMcpGrantAdapter } from './mcp/postgres-mcp-grant.adapter.js';
import { AICredentialsModule } from './ai/ai-credentials.module.js';
import { AICredentialService } from './ai/ai-credential.service.js';
import { AgentConversationsModule } from './agent/agent-conversations.module.js';
import {
  AGENT_TOOL_PAGE_LIMIT,
  CREATE_TRANSACTION_TOOL,
  CREATE_TRANSFER_TOOL,
} from './agent/agent-tools.js';
import { CliDeviceModule } from './cli-device/cli-device.module.js';

function validateAgentTransaction(input: unknown) {
  try {
    return createTransactionCommand(input);
  } catch (error) {
    if (
      error instanceof TransactionCommandValidationError ||
      error instanceof TransactionSplitsUnsupportedError
    )
      return null;
    throw error;
  }
}

function validateAgentTransfer(input: unknown) {
  try {
    return createTransferCommand(input);
  } catch (error) {
    if (error instanceof TransferCommandValidationError) return null;
    throw error;
  }
}

function approvalOutcome(
  result: unknown,
): Awaited<ReturnType<ApprovalExecutor>> {
  if (!result || typeof result !== 'object' || !('kind' in result))
    throw new Error('Invalid ledger outcome');
  switch (result.kind) {
    case TRANSACTION_CREATE_OUTCOMES.CREATED:
      return 'ok';
    case TRANSACTION_CREATE_OUTCOMES.FORBIDDEN:
      return 'forbidden';
    case TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT:
    case TRANSACTION_CREATE_OUTCOMES.RECEIPT_ALREADY_LINKED:
    case TRANSACTION_CREATE_OUTCOMES.REPLAYED:
      return 'conflict';
    default:
      return 'invalid_action';
  }
}

function authorizeLedgerTool(
  grants: McpGrantAuthorizer,
  client: TransactionClient,
  identity: McpProposalIdentity,
  workspaceId: string,
  toolName: string,
  command: CreateTransactionCommand | CreateTransferCommand,
): Promise<boolean> {
  return grants.authorizeMcpGrant(client, {
    ...identity,
    workspaceId,
    toolName,
    accountIds:
      'accountId' in command
        ? [command.accountId]
        : [command.sourceAccountId, command.destinationAccountId],
    // A same-currency transfer is one monetary effect, not two.
    amounts: [command.amount],
  });
}

type ToolArguments = Record<string, unknown>;

function normalizeMcpArguments(toolName: string, args: ToolArguments) {
  if (toolName === CREATE_TRANSACTION_TOOL) {
    const command = validateAgentTransaction(args);
    if (!command) return null;
    const tagIds = (command.tagIds ?? []).map((tag) => tag.toLowerCase());
    if (new Set(tagIds).size !== tagIds.length) return null;
    tagIds.sort();
    return {
      ...command,
      accountId: command.accountId.toLowerCase(),
      categoryId: command.categoryId?.toLowerCase() ?? null,
      payeeId: command.payeeId?.toLowerCase() ?? null,
      receiptId: command.receiptId?.toLowerCase() ?? null,
      tagIds,
      amount: {
        ...command.amount,
        amountMinor: BigInt(command.amount.amountMinor).toString(),
      },
    };
  }
  // The ledger posts only the two principal legs and stores no description.
  if (toolName !== CREATE_TRANSFER_TOOL || hasUnsupportedTransferFields(args))
    return null;
  const command = validateAgentTransfer(args);
  if (!command) return null;
  return {
    sourceAccountId: command.sourceAccountId.toLowerCase(),
    destinationAccountId: command.destinationAccountId.toLowerCase(),
    amount: {
      ...command.amount,
      amountMinor: BigInt(command.amount.amountMinor).toString(),
    },
    occurredAt: command.occurredAt,
  };
}

function hasUnsupportedTransferFields(args: ToolArguments): boolean {
  return Object.hasOwn(args, 'fee') || Object.hasOwn(args, 'description');
}

const approvals = ApprovalsModule.withExecutors(
  [
    LedgerModule,
    McpGrantsModule,
    AccountsModule,
    BudgetsModule,
    FundsModule,
    ReportsModule,
  ],
  {
    inject: [
      LEDGER_WRITER,
      TransferService,
      PostgresMcpGrantAdapter,
      TransactionService,
      AccountsService,
      CurrencyExchangeService,
      BudgetService,
      FundService,
      ReportService,
    ],
    useFactory: (
      writer: LedgerWriter,
      transfers: TransferService,
      grants: McpGrantAuthorizer,
      transactions: TransactionService,
      accounts: AccountsService,
      exchanges: CurrencyExchangeService,
      budgets: BudgetService,
      funds: FundService,
      reports: ReportService,
    ) => {
      const create: ApprovalExecutor = async (
        client,
        subject,
        workspaceId,
        approvalId,
        args,
        grantId,
      ) => {
        const command = validateAgentTransaction(args);
        if (!command) return 'invalid_action';
        if (
          grantId &&
          !(await authorizeLedgerTool(
            grants,
            client,
            { subject, grantId },
            workspaceId,
            CREATE_TRANSACTION_TOOL,
            command,
          ))
        ) {
          return 'forbidden';
        }
        // A key in the internal namespace cannot collide with UUID-only HTTP keys.
        const result = await writer.createTransaction(
          client,
          subject,
          workspaceId,
          command,
          `${grantId ? 'mcp' : 'agent'}:${approvalId}`,
        );
        return approvalOutcome(result);
      };
      const transfer: ApprovalExecutor = async (
        client,
        subject,
        workspaceId,
        approvalId,
        args,
        grantId,
      ) => {
        const command = validateAgentTransfer(args);
        if (!command || (grantId && hasUnsupportedTransferFields(args)))
          return 'invalid_action';
        if (
          grantId &&
          !(await authorizeLedgerTool(
            grants,
            client,
            { subject, grantId },
            workspaceId,
            CREATE_TRANSFER_TOOL,
            command,
          ))
        ) {
          return 'forbidden';
        }
        return approvalOutcome(
          await transfers.createWithin(
            client,
            subject,
            workspaceId,
            command,
            `${grantId ? 'mcp' : 'agent'}:${approvalId}`,
          ),
        );
      };
      return new Map<string, ApprovalExecutor>([
        [CREATE_TRANSACTION_TOOL, create],
        [CREATE_TRANSFER_TOOL, transfer],
        ...[
          ...mcpAccountWrites(accounts, exchanges, grants),
          ...mcpBudgetWrites(budgets, grants),
          ...mcpFundReportWrites(funds, reports, grants),
        ].map(({ name, execute }) => [name, execute] as const),
        ...TRANSACTION_MUTATIONS.map(
          (tool) =>
            [
              tool,
              transactionMutationExecutor(tool, transactions, grants),
            ] as const,
        ),
      ]);
    },
  },
);

const proposalImports = [
  approvals,
  McpGrantsModule,
  LedgerModule,
  AccountsModule,
  BudgetsModule,
  FundsModule,
  ReportsModule,
];
const mcpProposals = McpProposalsModule.withPort(proposalImports, {
  inject: [
    ApprovalService,
    PostgresMcpGrantAdapter,
    TransactionService,
    TransferService,
    AccountsService,
    CurrencyExchangeService,
    BudgetService,
    FundService,
    ReportService,
  ],
  useFactory: (
    requests: ApprovalService,
    grants: McpGrantAuthorizer,
    transactions: TransactionService,
    transfers: TransferService,
    accounts: AccountsService,
    exchanges: CurrencyExchangeService,
    budgets: BudgetService,
    funds: FundService,
    reports: ReportService,
  ) => {
    const writes = new Map(
      [
        ...mcpAccountWrites(accounts, exchanges, grants),
        ...mcpBudgetWrites(budgets, grants),
        ...mcpFundReportWrites(funds, reports, grants),
      ].map(({ name, propose }) => [name, propose(requests)]),
    );
    return async (identity, workspaceId, toolName, args, key) => {
      const write = writes.get(toolName);
      if (write) return write(identity, workspaceId, toolName, args, key);
      const tool = MCP_TOOL_ANNOTATIONS.get(toolName);
      if (!tool?.requiresApproval || tool.riskClass === 'read')
        return { kind: 'invalid' };
      if (isTransactionMutation(toolName)) {
        return proposeTransactionMutation(
          requests,
          transactions,
          grants,
          identity,
          workspaceId,
          toolName,
          args,
          key,
        );
      }
      const command = normalizeMcpArguments(toolName, args);
      if (!command) return { kind: 'invalid' };
      return requests.createMcpProposal(
        identity.subject,
        workspaceId,
        {
          toolName,
          grantId: identity.grantId,
          riskClass: tool.riskClass,
          arguments: command,
          preview: { ...command, action: toolName, workspaceId },
        },
        key,
        (client) =>
          authorizeLedgerTool(
            grants,
            client,
            identity,
            workspaceId,
            toolName,
            command,
          ),
        async (client) => {
          if ('accountId' in command) {
            return transactions.preflightCreateWithin(
              client,
              workspaceId,
              command,
            );
          }
          const failure = await transfers.checkCreateAccounts(
            client,
            workspaceId,
            command,
          );
          return failure ? 'invalid' : 'ok';
        },
      );
    };
  },
});

@Module({
  controllers: [HealthController],
  imports: [
    PlatformModule,
    IdentityModule,
    AccountsModule,
    LedgerModule,
    CurrenciesModule,
    CatalogsModule,
    RecurringModule,
    JobsModule,
    ReconciliationsModule,
    ExportsModule,
    ImportsModule,
    BudgetsModule,
    FundsModule,
    DebtsModule,
    AnalyticsModule,
    ScenariosModule,
    ForecastsModule,
    ReportsModule,
    approvals,
    NotificationsModule,
    ReceiptsModule,
    McpGrantsModule,
    mcpProposals,
    AICredentialsModule,
    AgentConversationsModule.withCredentialResolver(
      [AICredentialsModule, AccountsModule, LedgerModule, approvals],
      {
        inject: [AICredentialService],
        useFactory: (ai: AICredentialService) => (subject, workspaceId) =>
          ai.resolveAgentCredential(subject, workspaceId),
      },
      {
        inject: [ACCOUNTS_PORT, LEDGER_PORT, APPROVALS_PORT],
        useFactory: (
          accounts: AccountsPort,
          ledger: LedgerPort,
          requests: ApprovalsPort,
        ) => ({
          listAccounts: async ({ subject, workspaceId }) => {
            const result = await accounts.list(subject, {
              workspaceId,
              limit: AGENT_TOOL_PAGE_LIMIT,
            });
            return result.kind === 'ok' ? result.page : undefined;
          },
          listRecentTransactions: async ({ subject, workspaceId }) => {
            const result = await ledger.list(subject, {
              workspaceId,
              limit: AGENT_TOOL_PAGE_LIMIT,
            });
            return result.kind === 'ok' ? result.page : undefined;
          },
          validateTransaction: validateAgentTransaction,
          validateTransfer: validateAgentTransfer,
          canUseAccount: async ({ subject, workspaceId }, accountId) =>
            (await accounts.read(subject, workspaceId, accountId)).kind ===
            'ok',
          createApproval: async ({ subject, workspaceId }, proposal) => {
            const result = await requests.createApproval(
              subject,
              workspaceId,
              proposal,
            );
            return result.kind === 'ok' ? result.approval.id : undefined;
          },
        }),
      },
    ),
    CliDeviceModule,
  ],
})
export class AppModule {}
