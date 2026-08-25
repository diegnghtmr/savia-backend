import { describe, expect, it, vi } from 'vitest';

import {
  decodeAccountCursor,
  ACCOUNT_LIST_OUTCOMES,
  type Account,
  type AccountListOutcome,
} from '../../src/accounts/accounts.port.js';
import {
  AccountsService,
  type AccountsStore,
} from '../../src/accounts/accounts.service.js';
import type { TransactionClient } from '../../src/identity/pg-transaction.js';

const SUBJECT = '00000000-0000-0000-0000-000000000901';
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000951';

const CLIENT: TransactionClient = { query: vi.fn() };

class FakeReadTransaction {
  public async runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (subject !== SUBJECT) throw new Error('unexpected subject');
    return callback(CLIENT);
  }
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: '00000000-0000-0000-0000-000000000a01',
    name: 'Cash wallet',
    type: 'cash',
    currency: 'USD',
    status: 'active',
    institution: null,
    maskedNumber: null,
    description: null,
    colorToken: null,
    icon: null,
    includeInNetWorth: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function fakeStore(
  role: string | undefined,
  rows: readonly Account[] = [],
): AccountsStore & {
  readActiveRole: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
} {
  return {
    readActiveRole: vi.fn().mockResolvedValue(role),
    listAccounts: vi.fn().mockResolvedValue(rows),
  };
}

async function list(
  store: AccountsStore,
  query: Parameters<AccountsService['list']>[1],
): Promise<AccountListOutcome> {
  const service = new AccountsService(new FakeReadTransaction(), store);
  return service.list(SUBJECT, query);
}

describe('AccountsService.list', () => {
  it('answers forbidden when the actor holds no active role in the workspace and never queries the page', async () => {
    const store = fakeStore(undefined);
    const outcome = await list(store, { workspaceId: WORKSPACE_ID, limit: 50 });
    expect(outcome.kind).toBe(ACCOUNT_LIST_OUTCOMES.FORBIDDEN);
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(store.listAccounts).not.toHaveBeenCalled();
  });

  it('answers forbidden for a workspace that does not exist instead of an empty page', async () => {
    // The workspace_actor_active_role helper returns NULL when the workspace is
    // absent, exactly as it does for a non-member; both must collapse to the
    // same refusal because the authority declares no 404 on listAccounts.
    const store = fakeStore(undefined);
    const outcome = await list(store, { workspaceId: WORKSPACE_ID, limit: 50 });
    expect(outcome.kind).toBe(ACCOUNT_LIST_OUTCOMES.FORBIDDEN);
    if (outcome.kind === ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error('an empty page must never stand in for a refusal');
    }
  });

  it('returns a genuinely empty ok page for a member of a workspace without accounts', async () => {
    const store = fakeStore('owner', []);
    const outcome = await list(store, { workspaceId: WORKSPACE_ID, limit: 50 });
    expect(outcome).toEqual({
      kind: ACCOUNT_LIST_OUTCOMES.OK,
      page: {
        items: [],
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    });
  });

  it('admits a viewer because the select policy admits all four roles', async () => {
    const rows = [account()];
    const store = fakeStore('viewer', rows);
    const outcome = await list(store, { workspaceId: WORKSPACE_ID, limit: 50 });
    if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.page.items).toEqual(rows);
  });

  it('fetches one row beyond the limit, reports hasNextPage, and encodes the cursor over the last returned item', async () => {
    const first = account({ id: '00000000-0000-0000-0000-000000000a01' });
    const second = account({
      id: '00000000-0000-0000-0000-000000000a02',
      createdAt: '2026-07-02T00:00:00.000Z',
    });
    const third = account({
      id: '00000000-0000-0000-0000-000000000a03',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const store = fakeStore('owner', [first, second, third]);
    const outcome = await list(store, { workspaceId: WORKSPACE_ID, limit: 2 });
    if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.page.items).toEqual([first, second]);
    expect(outcome.page.pageInfo.hasNextPage).toBe(true);
    expect(decodeAccountCursor(outcome.page.pageInfo.nextCursor ?? '')).toEqual(
      { createdAt: second.createdAt, id: second.id },
    );
    // The store is asked for limit + 1 so hasNextPage is decidable without a
    // second query.
    expect(store.listAccounts).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      undefined,
      3,
      undefined,
    );
  });

  it('forwards the decoded cursor and the status filter to the store', async () => {
    const store = fakeStore('owner', []);
    const outcome = await list(store, {
      workspaceId: WORKSPACE_ID,
      limit: 10,
      status: 'archived',
    });
    expect(outcome.kind).toBe(ACCOUNT_LIST_OUTCOMES.OK);
    expect(store.listAccounts).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      undefined,
      11,
      'archived',
    );
  });

  it('forwards a supplied cursor to the store untouched', async () => {
    const store = fakeStore('owner', []);
    const cursor = { createdAt: '2026-07-01T00:00:00.000Z', id: account().id };
    await list(store, { workspaceId: WORKSPACE_ID, limit: 10, cursor });
    expect(store.listAccounts).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      cursor,
      11,
      undefined,
    );
  });
});
