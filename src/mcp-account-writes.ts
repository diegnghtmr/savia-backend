import {
  AccountCommandValidationError,
  createAccountCommand,
} from './accounts/account-command.js';
import type { AccountsService } from './accounts/accounts.service.js';
import {
  createCurrencyExchangeCommand,
  CurrencyExchangeCommandValidationError,
} from './ledger/currency-exchange-command.js';
import type { CurrencyExchangeService } from './ledger/currency-exchange.service.js';
import { defineMcpWrite } from './mcp-write.js';
import type { McpGrantAuthorizer, Money } from './mcp/mcp-grant.port.js';

function minorUnits(money: Money): Money {
  return { ...money, amountMinor: BigInt(money.amountMinor).toString() };
}

export function mcpAccountWrites(
  accounts: AccountsService,
  exchanges: CurrencyExchangeService,
  grants: McpGrantAuthorizer,
) {
  return [
    defineMcpWrite('create_account', grants, {
      parse(args) {
        try {
          const command = createAccountCommand(args);
          const { openingBalance } = command;
          return openingBalance
            ? { ...command, openingBalance: minorUnits(openingBalance) }
            : command;
        } catch (error) {
          if (error instanceof AccountCommandValidationError) return undefined;
          throw error;
        }
      },
      // The account does not exist yet; an account-restricted grant cannot create it.
      amounts: ({ openingBalance, currency }) => [
        openingBalance ?? { amountMinor: '0', currency },
      ],
      validate: async (client, workspaceId, command) =>
        (await accounts.canCreateWithin(client, workspaceId, command))
          ? 'ok'
          : 'invalid',
      apply: (client, subject, workspaceId, command, key) =>
        accounts.create(subject, workspaceId, command, key, client),
    }),
    defineMcpWrite('create_cross_currency_transfer', grants, {
      parse(args) {
        // The direct route does not post a fee debit or persist a description.
        if (Object.hasOwn(args, 'fee') || Object.hasOwn(args, 'description'))
          return undefined;
        try {
          const command = createCurrencyExchangeCommand(args);
          return {
            ...command,
            description: undefined,
            sourceAccountId: command.sourceAccountId.toLowerCase(),
            destinationAccountId: command.destinationAccountId.toLowerCase(),
            sourceAmount: minorUnits(command.sourceAmount),
            destinationAmount: minorUnits(command.destinationAmount),
          };
        } catch (error) {
          if (error instanceof CurrencyExchangeCommandValidationError)
            return undefined;
          throw error;
        }
      },
      accountIds: ({ sourceAccountId, destinationAccountId }) => [
        sourceAccountId,
        destinationAccountId,
      ],
      amounts: ({ sourceAmount, destinationAmount }) => [
        sourceAmount,
        destinationAmount,
      ],
      validate: async (client, workspaceId, command) =>
        (await exchanges.checkCreateAccounts(client, workspaceId, command))
          ? 'invalid'
          : 'ok',
      apply: (client, subject, workspaceId, command, key) =>
        exchanges.create(subject, workspaceId, command, key, client),
    }),
  ];
}
