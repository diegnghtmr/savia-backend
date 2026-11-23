import {
  createFundCommand,
  createFundContributionCommand,
  FundCommandValidationError,
} from './funds/fund-command.js';
import type { FundService } from './funds/fund.service.js';
import { defineMcpWrite } from './mcp-write.js';
import type { McpGrantAuthorizer, Money } from './mcp/mcp-grant.port.js';
import type { TransactionClient } from './platform/pg-transaction.js';
import { UUID_PATTERN } from './platform/uuid.js';
import {
  createReportDefinitionCommand,
  ReportCommandValidationError,
} from './reports/report-command.js';
import type { ReportService } from './reports/report.service.js';

function parse<T>(apply: () => T): T | undefined {
  try {
    return apply();
  } catch (error) {
    if (
      error instanceof FundCommandValidationError ||
      error instanceof ReportCommandValidationError
    )
      return undefined;
    throw error;
  }
}

function normalizeMoney(money: Money): Money {
  return { ...money, amountMinor: BigInt(money.amountMinor).toString() };
}

async function validInput(
  client: TransactionClient,
  value: string,
  type: 'date' | 'timestamp with time zone' | 'jsonb',
): Promise<boolean> {
  const { rows } = await client.query<{ valid: boolean }>(
    'select pg_input_is_valid($1, $2) as valid',
    [value, type],
  );
  return rows[0]?.valid === true;
}

export function mcpFundReportWrites(
  funds: FundService,
  reports: ReportService,
  grants: McpGrantAuthorizer,
) {
  return [
    defineMcpWrite('create_sinking_fund', grants, {
      parse: (args) =>
        parse(() => {
          const command = createFundCommand(args);
          return {
            ...command,
            targetAmount: normalizeMoney(command.targetAmount),
          };
        }),
      accountIds: ({ linkedAccountId }) =>
        linkedAccountId ? [linkedAccountId] : [],
      amounts: ({ targetAmount }) => [targetAmount],
      validate: async (
        client,
        workspaceId,
        { linkedAccountId, targetDate },
      ) => {
        if (
          !(await funds.checkLinkedAccountWithin(
            client,
            workspaceId,
            linkedAccountId,
          ))
        )
          return 'invalid';
        return !targetDate || (await validInput(client, targetDate, 'date'))
          ? 'ok'
          : 'invalid';
      },
      apply: (client, subject, workspaceId, command, key) =>
        funds.createFund(subject, workspaceId, command, key, client),
    }),
    defineMcpWrite('contribute_to_fund', grants, {
      parse: (args) =>
        parse(() => {
          const { fundId, body } = args;
          if (
            Object.keys(args).length !== 2 ||
            typeof fundId !== 'string' ||
            !UUID_PATTERN.test(fundId)
          )
            return undefined;
          const command = createFundContributionCommand(body);
          return {
            fundId: fundId.toLowerCase(),
            body: { ...command, amount: normalizeMoney(command.amount) },
          };
        }),
      // Contributions post to the source account and an external leg, not to a linked account.
      accountIds: ({ body }) => [body.accountId],
      amounts: ({ body }) => [body.amount],
      validate: async (client, workspaceId, { fundId, body }) => {
        const target = await funds.checkContributionWithin(
          client,
          workspaceId,
          fundId,
          body,
        );
        if (target.kind !== 'ok') return 'invalid';
        return (await validInput(
          client,
          body.occurredAt,
          'timestamp with time zone',
        ))
          ? 'ok'
          : 'invalid';
      },
      apply: (client, subject, workspaceId, { fundId, body }, key) =>
        funds.contributeToFund(subject, workspaceId, fundId, body, key, client),
    }),
    defineMcpWrite('create_report_definition', grants, {
      parse: (args) => parse(() => createReportDefinitionCommand(args)),
      amounts: () => [],
      validate: async (client, _workspaceId, command) => {
        if (command.name.includes('\0')) return 'invalid';
        return (await validInput(
          client,
          JSON.stringify(command.filters),
          'jsonb',
        ))
          ? 'ok'
          : 'invalid';
      },
      apply: (client, subject, workspaceId, command, key) =>
        reports.createReportDefinition(
          subject,
          workspaceId,
          command,
          key,
          client,
        ),
    }),
  ];
}
