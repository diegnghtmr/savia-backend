import type { TransactionClient } from '../identity/pg-transaction.js';
import {
  ACCOUNT_LIST_OUTCOMES,
  encodeAccountCursor,
  type Account,
  type AccountCursor,
  type AccountListOutcome,
  type AccountListQuery,
  type AccountStatus,
  type AccountsPort,
} from './accounts.port.js';

export interface AccountsReadTransaction {
  runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface AccountsStore {
  // Returns the caller's active role inside the workspace through the same
  // public.workspace_actor_active_role helper the accounts RLS policies use,
  // or undefined when there is no active membership. An absent workspace
  // returns undefined too, which is what keeps a nonexistent workspace
  // indistinguishable from a denied one (listAccounts declares no 404).
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  listAccounts(
    client: TransactionClient,
    workspaceId: string,
    cursor: AccountCursor | undefined,
    limit: number,
    status: AccountStatus | undefined,
  ): Promise<readonly Account[]>;
}

export class AccountsService implements AccountsPort {
  public constructor(
    private readonly transaction: AccountsReadTransaction,
    private readonly store: AccountsStore,
  ) {}

  public list(
    subject: string,
    query: AccountListQuery,
  ): Promise<AccountListOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, query.workspaceId);
      if (role === undefined) {
        // Refusal, not an empty page: the authority declares no 404, and an
        // empty 200 would stand in for an authorization failure.
        return { kind: ACCOUNT_LIST_OUTCOMES.FORBIDDEN };
      }
      // The select policy admits all four roles, so any non-null active role
      // authorizes the read; RLS still filters every row below.
      const rows = await this.store.listAccounts(
        client,
        query.workspaceId,
        query.cursor,
        query.limit + 1,
        query.status,
      );
      const hasNextPage = rows.length > query.limit;
      const items = hasNextPage ? rows.slice(0, query.limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeAccountCursor({
              createdAt: lastItem.createdAt,
              id: lastItem.id,
            })
          : null;
      return {
        kind: ACCOUNT_LIST_OUTCOMES.OK,
        page: {
          items,
          pageInfo: {
            hasNextPage,
            nextCursor,
          },
        },
      };
    });
  }
}
