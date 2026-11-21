import { Module } from '@nestjs/common';

import { AccountsModule } from './accounts/accounts.module.js';
import { ACCOUNTS_PORT, type AccountsPort } from './accounts/accounts.port.js';
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
import {
  LEDGER_WRITER,
  type LedgerWriter,
} from './platform/ledger-writer.port.js';
import { PlatformModule } from './platform/platform.module.js';
import { RecurringModule } from './recurring/recurring.module.js';
import { ReconciliationsModule } from './reconciliations/reconciliations.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { FundsModule } from './funds/funds.module.js';
import { DebtsModule } from './debts/debts.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { ScenariosModule } from './scenarios/scenarios.module.js';
import { ForecastsModule } from './forecasts/forecasts.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import {
  APPROVALS_PORT,
  type ApprovalExecutor,
  type ApprovalsPort,
} from './approvals/approval.port.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ReceiptsModule } from './receipts/receipts.module.js';
import { McpGrantsModule } from './mcp/mcp-grants.module.js';
import { AICredentialsModule } from './ai/ai-credentials.module.js';
import { AICredentialService } from './ai/ai-credential.service.js';
import { AgentConversationsModule } from './agent/agent-conversations.module.js';
import {
  AGENT_TOOL_PAGE_LIMIT,
  CREATE_TRANSACTION_TOOL,
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

const approvals = ApprovalsModule.withExecutors([LedgerModule], {
  inject: [LEDGER_WRITER],
  useFactory: (writer: LedgerWriter) => {
    const create: ApprovalExecutor = async (
      client,
      subject,
      workspaceId,
      approvalId,
      args,
    ) => {
      const command = validateAgentTransaction(args);
      if (!command) return 'invalid_action';
      // A key in the internal namespace cannot collide with UUID-only HTTP keys.
      const result = await writer.createTransaction(
        client,
        subject,
        workspaceId,
        command,
        `agent:${approvalId}`,
      );
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
    };
    return new Map([[CREATE_TRANSACTION_TOOL, create]]);
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
