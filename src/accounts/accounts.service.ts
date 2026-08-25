import type { TransactionClient } from '../platform/pg-transaction.js';
import { encodeCursor } from '../platform/cursor.js';
import {
  computeRequestFingerprint,
} from '../platform/idempotency.service.js';
import type { IdempotencyStore } from '../platform/idempotency.port.js';
import {
  ACCOUNT_CREATE_OUTCOMES,
  ACCOUNT_LIST_OUTCOMES,
  ACCOUNT_READ_OUTCOMES,
  type Account,
  type AccountCreateOutcome,
  type AccountCursor,
  type AccountListOutcome,
  type AccountListQuery,
  type AccountReadOutcome,
  type AccountStatus,
  type AccountsPort,
  type CreateAccountCommand,
} from './accounts.port.js';

export interface AccountItem {
  readonly account: Account;
  readonly cursorAt: string;
}

export interface AccountsTransaction {
  run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T>;
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
  ): Promise<readonly AccountItem[]>;
  readAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<Account | undefined>;
  createAccount(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateAccountCommand,
  ): Promise<Account>;
}

export class AccountsService implements AccountsPort {
  public constructor(
    private readonly transaction: AccountsTransaction,
    private readonly store: AccountsStore,
    private readonly idempotencyStore: IdempotencyStore,
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
      const visible = hasNextPage ? rows.slice(0, query.limit) : rows;
      const items = visible.map((entry) => entry.account);
      const lastItem = visible[visible.length - 1];
      const nextCursor =
        hasNextPage && lastItem !== undefined
          ? encodeCursor({
              createdAt: lastItem.cursorAt,
              id: lastItem.account.id,
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

  public read(
    subject: string,
    workspaceId: string,
    accountId: string,
  ): Promise<AccountReadOutcome> {
    return this.transaction.runRead(subject, async (client) => {
      const role = await this.store.readActiveRole(client, workspaceId);
      if (role === undefined) {
        // Workspace-level refusal happens before any account lookup.
        return { kind: ACCOUNT_READ_OUTCOMES.FORBIDDEN };
      }
      // The account lookup is scoped strictly by workspace_id in the store predicate,
      // so an absent account and a foreign workspace's account both return undefined (404).
      const account = await this.store.readAccount(
        client,
        workspaceId,
        accountId,
      );
      if (account === undefined) {
        return { kind: ACCOUNT_READ_OUTCOMES.NOT_FOUND };
      }
      return {
        kind: ACCOUNT_READ_OUTCOMES.OK,
        account,
      };
    });
  }

  public async create(
    subject: string,
    workspaceId: string,
    command: CreateAccountCommand,
    idempotencyKey: string,
  ): Promise<AccountCreateOutcome> {
    const route = 'POST /v1/accounts';
    const fingerprint = computeRequestFingerprint(command);

    return this.transaction.run(subject, async (client) => {
      // Check authorization before any write
      const role = await this.store.readActiveRole(client, workspaceId);
      if (
        role === undefined ||
        !['owner', 'administrator', 'editor'].includes(role)
      ) {
        return { kind: ACCOUNT_CREATE_OUTCOMES.FORBIDDEN };
      }

      // Idempotency preamble
      const existing = await this.idempotencyStore.read(
        client,
        subject,
        route,
        idempotencyKey,
        workspaceId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          return { kind: ACCOUNT_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
        }
        return {
          kind: ACCOUNT_CREATE_OUTCOMES.REPLAYED,
          status: existing.responseStatus,
          etag: existing.responseEtag,
          body: existing.responseBody,
        };
      }

      // Create account
      const account = await this.store.createAccount(
        client,
        workspaceId,
        subject,
        command,
      );

      // Write idempotency record with workspaceId threaded
      const written = await this.idempotencyStore.write(
        client,
        subject,
        route,
        idempotencyKey,
        fingerprint,
        201,
        `"${account.version}"`,
        account,
        workspaceId,
      );

      if (!written) {
        // A losing write means a live record won and the response must come from that record.
        const reread = await this.idempotencyStore.read(
          client,
          subject,
          route,
          idempotencyKey,
          workspaceId,
        );
        if (reread !== undefined) {
          if (reread.requestFingerprint !== fingerprint) {
            return { kind: ACCOUNT_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT };
          }
          return {
            kind: ACCOUNT_CREATE_OUTCOMES.REPLAYED,
            status: reread.responseStatus,
            etag: reread.responseEtag,
            body: reread.responseBody,
          };
        }
      }

      return {
        kind: ACCOUNT_CREATE_OUTCOMES.CREATED,
        account,
      };
    });
  }
}

