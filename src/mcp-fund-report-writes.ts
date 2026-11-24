import {
  createFundCommand,
  createFundContributionCommand,
  createFundWithdrawalCommand,
  FundCommandValidationError,
  parseFundIfMatch,
  updateFundCommand,
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
    defineMcpWrite('update_sinking_fund', grants, {
      parse: (args) =>
        parse(() => {
          const { fundId, body } = args;
          const ifMatch = parseFundIfMatch(args.ifMatch);
          if (
            Object.keys(args).length !== 3 ||
            typeof fundId !== 'string' ||
            !UUID_PATTERN.test(fundId) ||
            !ifMatch
          )
            return undefined;
          const command = updateFundCommand(body);
          if (
            command.name?.isWellFormed() === false ||
            command.objective?.isWellFormed() === false
          )
            return undefined;
          return {
            fundId: fundId.toLowerCase(),
            ifMatch,
            body: {
              ...command,
              targetAmount: command.targetAmount
                ? normalizeMoney(command.targetAmount)
                : undefined,
            },
          };
        }),
      accountIds: ({ body }) =>
        body.linkedAccountId ? [body.linkedAccountId] : [],
      amounts: async ({ fundId, body }, client, workspaceId) => {
        if (body.targetAmount) return [body.targetAmount];
        const target = await funds.readDetailWithin(
          client,
          workspaceId,
          fundId,
        );
        return target
          ? [{ amountMinor: '0', currency: target.fund.currency }]
          : [];
      },
      validate: async (client, workspaceId, { fundId, ifMatch, body }) => {
        const target = await funds.checkUpdateWithin(
          client,
          workspaceId,
          fundId,
          body,
          ifMatch,
        );
        return target.kind === 'ok' ? 'ok' : 'invalid';
      },
      snapshot: ({ fundId, ifMatch, body }) => ({
        fundId,
        ifMatch,
        body: Object.fromEntries(
          Object.entries(body).filter(([, value]) => value !== undefined),
        ),
      }),
      apply: async (
        client,
        subject,
        workspaceId,
        { fundId, ifMatch, body },
        key,
      ) => {
        const outcome = await funds.updateFund(
          subject,
          workspaceId,
          fundId,
          body,
          ifMatch,
          key,
          client,
        );
        return outcome.kind === 'stale'
          ? { kind: 'precondition-failed' }
          : outcome;
      },
    }),
    defineMcpWrite('withdraw_from_fund', grants, {
      parse: (args) =>
        parse(() => {
          const { fundId, body } = args;
          if (
            Object.keys(args).length !== 2 ||
            typeof fundId !== 'string' ||
            !UUID_PATTERN.test(fundId)
          )
            return undefined;
          const command = createFundWithdrawalCommand(body);
          if (!command.reason.isWellFormed()) return undefined;
          return {
            fundId: fundId.toLowerCase(),
            body: { ...command, amount: normalizeMoney(command.amount) },
          };
        }),
      // Withdrawal credits only the explicit destination account.
      accountIds: ({ body }) => [body.accountId],
      amounts: ({ body }) => [body.amount],
      validate: async (client, workspaceId, { fundId, body }) => {
        const target = await funds.checkContributionWithin(
          client,
          workspaceId,
          fundId,
          body,
        );
        // The shared withdrawal writer checks effective savings at booking time.
        return target.kind === 'ok' ? 'ok' : 'invalid';
      },
      snapshot: (command) => command,
      apply: (client, subject, workspaceId, { fundId, body }, key) =>
        funds.withdrawFromFund(subject, workspaceId, fundId, body, key, client),
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
