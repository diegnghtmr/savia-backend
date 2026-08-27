import { describe, expect, it, vi } from 'vitest';

import { decodeCursor } from '../../src/platform/cursor.js';
import {
  ACCOUNT_LIST_OUTCOMES,
  ACCOUNT_READ_OUTCOMES,
  ACCOUNT_UPDATE_OUTCOMES,
  type Account,
  type AccountListOutcome,
  type AccountReadOutcome,
  type AccountUpdateOutcome,
  type UpdateAccountCommand,
} from '../../src/accounts/accounts.port.js';
import {
  AccountsService,
  type AccountItem,
  type AccountsStore,
} from '../../src/accounts/accounts.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const SUBJECT = '00000000-0000-0000-0000-000000000901';
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000951';

const CLIENT: TransactionClient = { query: vi.fn() };

class FakeTransaction {
  public async run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (subject !== SUBJECT) throw new Error('unexpected subject');
    return callback(CLIENT);
  }

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

function toItem(
  acc: Account,
  cursorAt = '2026-07-01T00:00:00.000000Z',
): AccountItem {
  return { account: acc, cursorAt };
}

import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';

function fakeIdempotencyStore(
  record: IdempotencyRecord | undefined = undefined,
  writeSuccess = true,
): IdempotencyStore & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockResolvedValue(record),
    write: vi.fn().mockResolvedValue(writeSuccess),
  };
}

function fakeStore(
  role: string | undefined,
  rows: readonly (Account | AccountItem)[] = [],
  singleAccount: Account | undefined = undefined,
  createdAcc: Account = account(),
  updatedAcc: Account | undefined = account({
    name: 'Updated Name',
    version: 2,
  }),
): AccountsStore & {
  readActiveRole: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
  readAccount: ReturnType<typeof vi.fn>;
  createAccount: ReturnType<typeof vi.fn>;
  updateAccount: ReturnType<typeof vi.fn>;
} {
  const normalized: AccountItem[] = rows.map((r) =>
    'account' in r ? r : toItem(r),
  );
  return {
    readActiveRole: vi.fn().mockResolvedValue(role),
    listAccounts: vi.fn().mockResolvedValue(normalized),
    readAccount: vi.fn().mockResolvedValue(singleAccount),
    createAccount: vi.fn().mockResolvedValue(createdAcc),
    updateAccount: vi.fn().mockResolvedValue(updatedAcc),
  };
}

async function list(
  store: AccountsStore,
  query: Parameters<AccountsService['list']>[1],
): Promise<AccountListOutcome> {
  const service = new AccountsService(
    new FakeTransaction(),
    store,
    fakeIdempotencyStore(),
  );
  return service.list(SUBJECT, query);
}

async function read(
  store: AccountsStore,
  workspaceId: string,
  accountId: string,
): Promise<AccountReadOutcome> {
  const service = new AccountsService(
    new FakeTransaction(),
    store,
    fakeIdempotencyStore(),
  );
  return service.read(SUBJECT, workspaceId, accountId);
}

async function update(
  store: AccountsStore,
  workspaceId: string,
  accountId: string,
  command: UpdateAccountCommand,
  expectedVersions?: number | readonly number[],
): Promise<AccountUpdateOutcome> {
  const service = new AccountsService(
    new FakeTransaction(),
    store,
    fakeIdempotencyStore(),
  );
  return service.update(
    SUBJECT,
    workspaceId,
    accountId,
    command,
    expectedVersions,
  );
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

  it('fetches one row beyond the limit, reports hasNextPage, and encodes the cursor over the last returned item with microsecond precision', async () => {
    const first = account({ id: '00000000-0000-0000-0000-000000000a01' });
    const second = account({
      id: '00000000-0000-0000-0000-000000000a02',
      createdAt: '2026-07-02T00:00:00.000Z',
    });
    const third = account({
      id: '00000000-0000-0000-0000-000000000a03',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    const store = fakeStore('owner', [
      { account: first, cursorAt: '2026-07-01T00:00:00.000100Z' },
      { account: second, cursorAt: '2026-07-02T00:00:00.000200Z' },
      { account: third, cursorAt: '2026-07-03T00:00:00.000300Z' },
    ]);
    const outcome = await list(store, { workspaceId: WORKSPACE_ID, limit: 2 });
    if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.page.items).toEqual([first, second]);
    expect(outcome.page.pageInfo.hasNextPage).toBe(true);
    expect(decodeCursor(outcome.page.pageInfo.nextCursor ?? '')).toEqual({
      createdAt: '2026-07-02T00:00:00.000200Z',
      id: second.id,
    });
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
    const cursor = {
      createdAt: '2026-07-01T00:00:00.000500Z',
      id: account().id,
    };
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

describe('AccountsService.read', () => {
  it('answers forbidden when the actor holds no active role in the workspace and never queries the account', async () => {
    const store = fakeStore(undefined, [], account());
    const outcome = await read(store, WORKSPACE_ID, account().id);
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.FORBIDDEN);
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(store.readAccount).not.toHaveBeenCalled();
  });

  it('answers forbidden for a workspace that does not exist', async () => {
    const store = fakeStore(undefined, [], account());
    const outcome = await read(store, WORKSPACE_ID, account().id);
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.FORBIDDEN);
  });

  it('answers not_found when the account does not exist in the store', async () => {
    const store = fakeStore('owner', [], undefined);
    const outcome = await read(store, WORKSPACE_ID, account().id);
    expect(outcome.kind).toBe(ACCOUNT_READ_OUTCOMES.NOT_FOUND);
    expect(store.readAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      account().id,
    );
  });

  it('returns ok with the account when the actor is authorized and the account exists', async () => {
    const acc = account();
    const store = fakeStore('owner', [], acc);
    const outcome = await read(store, WORKSPACE_ID, acc.id);
    expect(outcome).toEqual({
      kind: ACCOUNT_READ_OUTCOMES.OK,
      account: acc,
    });
    expect(store.readAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      acc.id,
    );
  });

  it('admits a viewer because the select policy admits all four roles', async () => {
    const acc = account();
    const store = fakeStore('viewer', [], acc);
    const outcome = await read(store, WORKSPACE_ID, acc.id);
    expect(outcome).toEqual({
      kind: ACCOUNT_READ_OUTCOMES.OK,
      account: acc,
    });
  });
});

describe('AccountsService.create', () => {
  const IDEMPOTENCY_KEY = '00000000-0000-0000-0000-000000000001';
  const VALID_COMMAND = {
    name: 'New Checking',
    type: 'checking' as const,
    currency: 'USD',
    institution: 'Bank',
    maskedNumber: '***1234',
    description: 'Main account',
    includeInNetWorth: true,
  };

  it('answers forbidden when the actor holds no active role in the workspace and never queries idempotency or creates account', async () => {
    const store = fakeStore(undefined);
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn(),
    };
    const idempStore = fakeIdempotencyStore();
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe('forbidden');
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(idempStore.read).not.toHaveBeenCalled();
    expect(storeWithCreate.createAccount).not.toHaveBeenCalled();
  });

  it('answers forbidden when the actor is a viewer and never creates account', async () => {
    const store = fakeStore('viewer');
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn(),
    };
    const idempStore = fakeIdempotencyStore();
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe('forbidden');
    expect(storeWithCreate.createAccount).not.toHaveBeenCalled();
  });

  it('replays response when a matching idempotency record already exists without creating an account', async () => {
    const createdAccount = account({ name: 'New Checking' });
    const { computeRequestFingerprint } = await import(
      '../../src/platform/idempotency.service.js'
    );
    const fingerprint = computeRequestFingerprint(VALID_COMMAND);

    const store = fakeStore('owner');
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn(),
    };
    const idempStore = fakeIdempotencyStore({
      requestFingerprint: fingerprint,
      responseStatus: 201,
      responseEtag: '"1"',
      responseBody: createdAccount,
    });
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({
      kind: 'replayed',
      status: 201,
      etag: '"1"',
      body: createdAccount,
    });
    expect(storeWithCreate.createAccount).not.toHaveBeenCalled();
    expect(idempStore.write).not.toHaveBeenCalled();
  });

  it('answers conflict when an idempotency record exists with different fingerprint', async () => {
    const store = fakeStore('owner');
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn(),
    };
    const idempStore = fakeIdempotencyStore({
      requestFingerprint: 'different-fingerprint',
      responseStatus: 201,
      responseEtag: '"1"',
      responseBody: {},
    });
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe('idempotency_conflict');
    expect(storeWithCreate.createAccount).not.toHaveBeenCalled();
  });

  it('creates account and writes idempotency record with workspace_id when authorized', async () => {
    const createdAccount = account({ name: 'New Checking' });
    const store = fakeStore('owner');
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn().mockResolvedValue(createdAccount),
    };
    const idempStore = fakeIdempotencyStore(undefined, true);
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({
      kind: 'created',
      account: createdAccount,
    });
    expect(storeWithCreate.createAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      SUBJECT,
      VALID_COMMAND,
    );
    expect(idempStore.write).toHaveBeenCalledWith(
      CLIENT,
      SUBJECT,
      'POST /v1/accounts',
      IDEMPOTENCY_KEY,
      expect.any(String),
      201,
      '"1"',
      createdAccount,
      WORKSPACE_ID,
    );
  });

  it('re-reads from idempotency store and returns replay when write loses race', async () => {
    const createdAccount = account({ name: 'New Checking' });
    const { computeRequestFingerprint } = await import(
      '../../src/platform/idempotency.service.js'
    );
    const fingerprint = computeRequestFingerprint(VALID_COMMAND);

    const store = fakeStore('editor');
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn().mockResolvedValue(createdAccount),
    };
    const idempStore: IdempotencyStore & { read: ReturnType<typeof vi.fn> } = {
      read: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        requestFingerprint: fingerprint,
        responseStatus: 201,
        responseEtag: '"1"',
        responseBody: createdAccount,
      }),
      write: vi.fn().mockResolvedValue(false),
    };
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({
      kind: 'replayed',
      status: 201,
      etag: '"1"',
      body: createdAccount,
    });
    expect(idempStore.read).toHaveBeenCalledTimes(2);
  });

  it('answers idempotency_conflict when the write loses the race AND the winning record was minted from a different payload', async () => {
    // The losing-write branch had one arm covered (re-read agrees, replay it) and
    // one arm not: a concurrent request that won the unique-key race with a
    // DIFFERENT body. Replaying that stored response would hand this caller
    // someone else's account, so the mismatch must surface as 409.
    const createdAccount = account({ name: 'New Checking' });
    const store = fakeStore('editor');
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn().mockResolvedValue(createdAccount),
    };
    const idempStore: IdempotencyStore & { read: ReturnType<typeof vi.fn> } = {
      read: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          requestFingerprint: 'a-fingerprint-from-some-other-payload',
          responseStatus: 201,
          responseEtag: '"1"',
          responseBody: account({ name: 'Someone Else Account' }),
        }),
      write: vi.fn().mockResolvedValue(false),
    };
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      VALID_COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe('idempotency_conflict');
    expect(idempStore.read).toHaveBeenCalledTimes(2);
  });

  it('admits administrator role as well as owner and editor', async () => {
    for (const role of ['owner', 'administrator', 'editor']) {
      const createdAccount = account({ name: 'New Checking' });
      const store = fakeStore(role);
      const storeWithCreate = {
        ...store,
        createAccount: vi.fn().mockResolvedValue(createdAccount),
      };
      const idempStore = fakeIdempotencyStore(undefined, true);
      const service = new AccountsService(
        new FakeTransaction(),
        storeWithCreate,
        idempStore,
      );

      const outcome = await service.create(
        SUBJECT,
        WORKSPACE_ID,
        VALID_COMMAND,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe('created');
    }
  });
});

describe('AccountsService.update', () => {
  const ACCOUNT_ID = '00000000-0000-0000-0000-000000000a01';
  const UPDATE_COMMAND: UpdateAccountCommand = { name: 'Updated Checking' };

  it('answers forbidden when the actor holds no active role in the workspace and never touches account store', async () => {
    const store = fakeStore(undefined);
    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.FORBIDDEN);
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it('answers forbidden when the actor holds viewer role (only owner, administrator, editor admitted)', async () => {
    const store = fakeStore('viewer');
    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.FORBIDDEN);
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it('answers not_found when the account does not exist in the workspace', async () => {
    const store = fakeStore('owner', [], undefined);
    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.NOT_FOUND);
    expect(store.readAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
    );
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it('answers closed when the account exists but is closed (closed accounts cannot be modified)', async () => {
    const closedAccount = account({
      id: ACCOUNT_ID,
      status: 'closed',
      version: 3,
    });
    const store = fakeStore('owner', [], closedAccount);
    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.CLOSED);
    expect(store.readAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
    );
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it('answers version_conflict (412) when expectedVersions is a single number and does not match account.version', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 2 });
    const store = fakeStore('owner', [], existing);
    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      1, // expected version 1 vs current 2
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.VERSION_CONFLICT);
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it('answers version_conflict (412) when expectedVersions is an array and does not include account.version', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 5 });
    const store = fakeStore('owner', [], existing);
    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      [1, 2, 3], // expected versions 1,2,3 vs current 5
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.VERSION_CONFLICT);
    expect(store.updateAccount).not.toHaveBeenCalled();
  });

  it('successfully updates account when expectedVersions matches current version', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const updated = account({
      id: ACCOUNT_ID,
      name: 'Updated Checking',
      version: 2,
    });
    const store = fakeStore('owner', [], existing, undefined, updated);

    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      1,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_UPDATE_OUTCOMES.OK,
      account: updated,
    });
    expect(store.updateAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      1,
    );
  });

  it('successfully updates account when expectedVersions is undefined (absent If-Match)', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const updated = account({
      id: ACCOUNT_ID,
      name: 'Updated Checking',
      version: 2,
    });
    const store = fakeStore('owner', [], existing, undefined, updated);

    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      undefined,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_UPDATE_OUTCOMES.OK,
      account: updated,
    });
    expect(store.updateAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      undefined,
    );
  });

  it.each(['owner', 'administrator', 'editor'] as const)(
    'admits %s role for update',
    async (role) => {
      const existing = account({ id: ACCOUNT_ID, version: 1 });
      const updated = account({
        id: ACCOUNT_ID,
        name: 'Updated Checking',
        version: 2,
      });
      const store = fakeStore(role, [], existing, undefined, updated);

      const outcome = await update(
        store,
        WORKSPACE_ID,
        ACCOUNT_ID,
        UPDATE_COMMAND,
      );

      expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.OK);
    },
  );

  it('handles concurrent version conflict when store.updateAccount returns undefined and account version changed', async () => {
    const initialAccount = account({ id: ACCOUNT_ID, version: 1 });
    const concurrentAccount = account({ id: ACCOUNT_ID, version: 2 });

    const store = fakeStore('owner');
    store.readAccount = vi
      .fn()
      .mockResolvedValueOnce(initialAccount)
      .mockResolvedValueOnce(concurrentAccount);
    store.updateAccount = vi.fn().mockResolvedValue(undefined);

    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
      1,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.VERSION_CONFLICT);
    expect(store.readAccount).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent closure when store.updateAccount returns undefined and account became closed', async () => {
    const initialAccount = account({
      id: ACCOUNT_ID,
      version: 1,
      status: 'active',
    });
    const closedAccount = account({
      id: ACCOUNT_ID,
      version: 1,
      status: 'closed',
    });

    const store = fakeStore('owner');
    store.readAccount = vi
      .fn()
      .mockResolvedValueOnce(initialAccount)
      .mockResolvedValueOnce(closedAccount);
    store.updateAccount = vi.fn().mockResolvedValue(undefined);

    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.CLOSED);
    expect(store.readAccount).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent deletion when store.updateAccount returns undefined and account was deleted', async () => {
    const initialAccount = account({ id: ACCOUNT_ID, version: 1 });

    const store = fakeStore('owner');
    store.readAccount = vi
      .fn()
      .mockResolvedValueOnce(initialAccount)
      .mockResolvedValueOnce(undefined);
    store.updateAccount = vi.fn().mockResolvedValue(undefined);

    const outcome = await update(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      UPDATE_COMMAND,
    );

    expect(outcome.kind).toBe(ACCOUNT_UPDATE_OUTCOMES.NOT_FOUND);
    expect(store.readAccount).toHaveBeenCalledTimes(2);
  });
});
