import { describe, expect, it, vi } from 'vitest';

import { decodeCursor } from '../../src/platform/cursor.js';
import {
  ACCOUNT_BALANCE_OUTCOMES,
  ACCOUNT_CLOSE_OUTCOMES,
  ACCOUNT_LIST_OUTCOMES,
  ACCOUNT_READ_OUTCOMES,
  ACCOUNT_UPDATE_OUTCOMES,
  type Account,
  type AccountBalance,
  type AccountBalanceOutcome,
  type AccountCloseOutcome,
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

function balance(overrides: Partial<AccountBalance> = {}): AccountBalance {
  return {
    accountId: '00000000-0000-0000-0000-000000000a01',
    nativeBalance: {
      amountMinor: '10000',
      currency: 'USD',
    },
    pendingBalance: {
      amountMinor: '2000',
      currency: 'USD',
    },
    reconciledBalance: {
      amountMinor: '3000',
      currency: 'USD',
    },
    baseCurrencyEquivalent: {
      original: {
        amountMinor: '10000',
        currency: 'USD',
      },
      converted: {
        amountMinor: '10000',
        currency: 'USD',
      },
      rate: '1',
      rateDate: '2026-07-01',
      rateSource: 'identity',
    },
    asOf: '2026-07-01T00:00:00.000Z',
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
  overrides: {
    readonly baseCurrency?: string | undefined;
    readonly singleBalance?: AccountBalance | undefined;
    readonly hasUnsettled?: boolean | undefined;
    readonly closedAcc?: Account | undefined;
  } = {},
): AccountsStore & {
  readActiveRole: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
  readAccount: ReturnType<typeof vi.fn>;
  readAccountBalance: ReturnType<typeof vi.fn>;
  createAccount: ReturnType<typeof vi.fn>;
  updateAccount: ReturnType<typeof vi.fn>;
  hasUnsettledTransactions: ReturnType<typeof vi.fn>;
  closeAccount: ReturnType<typeof vi.fn>;
} {
  const normalized: AccountItem[] = rows.map((r) =>
    'account' in r ? r : toItem(r),
  );
  const resolvedClosedAcc =
    'closedAcc' in overrides
      ? overrides.closedAcc
      : account({ status: 'closed', version: 2 });
  return {
    readActiveRole: vi.fn().mockResolvedValue(role),
    listAccounts: vi.fn().mockResolvedValue(normalized),
    readAccount: vi.fn().mockResolvedValue(singleAccount),
    readAccountBalance: vi.fn().mockResolvedValue(overrides.singleBalance),
    createAccount: vi.fn().mockResolvedValue(createdAcc),
    updateAccount: vi.fn().mockResolvedValue(updatedAcc),
    hasUnsettledTransactions: vi
      .fn()
      .mockResolvedValue(overrides.hasUnsettled ?? false),
    closeAccount: vi.fn().mockResolvedValue(resolvedClosedAcc),
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

async function readBalance(
  store: AccountsStore,
  workspaceId: string,
  accountId: string,
  asOf?: string,
): Promise<AccountBalanceOutcome> {
  const service = new AccountsService(
    new FakeTransaction(),
    store,
    fakeIdempotencyStore(),
  );
  return service.readBalance(SUBJECT, workspaceId, accountId, asOf);
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

async function close(
  store: AccountsStore,
  workspaceId: string,
  accountId: string,
  idempotencyKey: string,
  expectedVersions?: number | readonly number[],
  idempStore: IdempotencyStore = fakeIdempotencyStore(),
): Promise<AccountCloseOutcome> {
  const service = new AccountsService(new FakeTransaction(), store, idempStore);
  return service.close(
    SUBJECT,
    workspaceId,
    accountId,
    idempotencyKey,
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

describe('AccountsService.readBalance', () => {
  it('answers forbidden when the actor holds no active role in the workspace and never queries the balance', async () => {
    const store = fakeStore(undefined, [], undefined, undefined, undefined, {
      singleBalance: balance(),
    });
    const outcome = await readBalance(store, WORKSPACE_ID, account().id);
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.FORBIDDEN);
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(store.readAccountBalance).not.toHaveBeenCalled();
  });

  it('answers forbidden for a workspace that does not exist', async () => {
    const store = fakeStore(undefined, [], undefined, undefined, undefined, {
      singleBalance: balance(),
    });
    const outcome = await readBalance(store, WORKSPACE_ID, account().id);
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.FORBIDDEN);
  });

  it('answers not_found when the account does not exist in the store', async () => {
    const store = fakeStore('owner', [], undefined, undefined, undefined);
    const outcome = await readBalance(store, WORKSPACE_ID, account().id);
    expect(outcome.kind).toBe(ACCOUNT_BALANCE_OUTCOMES.NOT_FOUND);
    expect(store.readAccountBalance).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      account().id,
      undefined,
    );
  });

  it('returns ok with the balance when the actor is authorized and the balance exists', async () => {
    const bal = balance();
    const store = fakeStore('owner', [], undefined, undefined, undefined, {
      singleBalance: bal,
    });
    const outcome = await readBalance(store, WORKSPACE_ID, bal.accountId);
    expect(outcome).toEqual({
      kind: ACCOUNT_BALANCE_OUTCOMES.OK,
      balance: bal,
    });
    expect(store.readAccountBalance).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      bal.accountId,
      undefined,
    );
  });

  it('admits a viewer because the select policy admits all four roles', async () => {
    const bal = balance();
    const store = fakeStore('viewer', [], undefined, undefined, undefined, {
      singleBalance: bal,
    });
    const outcome = await readBalance(store, WORKSPACE_ID, bal.accountId);
    expect(outcome).toEqual({
      kind: ACCOUNT_BALANCE_OUTCOMES.OK,
      balance: bal,
    });
  });

  it('forwards asOf parameter to the store', async () => {
    const bal = balance();
    const store = fakeStore('owner', [], undefined, undefined, undefined, {
      singleBalance: bal,
    });
    const asOf = '2026-06-15T12:00:00.000Z';
    const outcome = await readBalance(store, WORKSPACE_ID, bal.accountId, asOf);
    expect(outcome).toEqual({
      kind: ACCOUNT_BALANCE_OUTCOMES.OK,
      balance: bal,
    });
    expect(store.readAccountBalance).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      bal.accountId,
      asOf,
    );
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

  it('forwards command with non-base currency to store without application-level currency refusal (D4)', async () => {
    const createdAccount = account({ currency: 'EUR' });
    const store = fakeStore('owner', [], undefined, createdAccount);
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
      { ...VALID_COMMAND, currency: 'EUR' },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe('created');
    expect(storeWithCreate.createAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      SUBJECT,
      { ...VALID_COMMAND, currency: 'EUR' },
    );
  });

  it('allows creation when command currency matches workspace base currency', async () => {
    const createdAccount = account({ currency: 'USD' });
    const store = fakeStore('owner', [], undefined, createdAccount, undefined, {
      baseCurrency: 'USD',
    });
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn().mockResolvedValue(createdAccount),
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
      { ...VALID_COMMAND, currency: 'USD' },
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({
      kind: 'created',
      account: createdAccount,
    });
    expect(store.readWorkspaceBaseCurrency).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
    );
    expect(storeWithCreate.createAccount).toHaveBeenCalledTimes(1);
  });

  it('allows creation in a non-USD workspace when currency matches that workspace base currency', async () => {
    const createdAccount = account({ currency: 'EUR' });
    const store = fakeStore('owner', [], undefined, createdAccount, undefined, {
      baseCurrency: 'EUR',
    });
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn().mockResolvedValue(createdAccount),
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
      { ...VALID_COMMAND, currency: 'EUR' },
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({
      kind: 'created',
      account: createdAccount,
    });
    expect(store.readWorkspaceBaseCurrency).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
    );
    expect(storeWithCreate.createAccount).toHaveBeenCalledTimes(1);
  });

  it('answers forbidden when workspace base currency read is undefined', async () => {
    const store = fakeStore('owner', [], undefined, account(), undefined, {
      baseCurrency: undefined,
    });
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

  it('replays stored successful 201 response under the same key even after workspace base currency changes', async () => {
    const createdAccount = account({ currency: 'USD' });
    let storedRecord: IdempotencyRecord | undefined;
    const idempStore: IdempotencyStore & {
      read: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    } = {
      read: vi.fn(async () => storedRecord),
      write: vi.fn(
        async (
          _client,
          _subject,
          _route,
          _key,
          fingerprint,
          status,
          etag,
          body,
        ) => {
          storedRecord = {
            requestFingerprint: fingerprint,
            responseStatus: status,
            responseEtag: etag,
            responseBody: body,
          };
          return true;
        },
      ),
    };

    const store = fakeStore('owner', [], undefined, createdAccount, undefined, {
      baseCurrency: 'USD',
    });
    const storeWithCreate = {
      ...store,
      createAccount: vi.fn().mockResolvedValue(createdAccount),
    };
    const service = new AccountsService(
      new FakeTransaction(),
      storeWithCreate,
      idempStore,
    );

    const first = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      { ...VALID_COMMAND, currency: 'USD' },
      IDEMPOTENCY_KEY,
    );
    expect(first).toEqual({
      kind: 'created',
      account: createdAccount,
    });
    expect(storeWithCreate.createAccount).toHaveBeenCalledTimes(1);

    // Workspace base currency mutates in store.
    storeWithCreate.readWorkspaceBaseCurrency.mockResolvedValue('EUR');

    // Pin the precondition this scenario is named for. Without these two lines
    // the test still passes when the mutation above is deleted, because the
    // idempotency branch returns before any second currency read: the scenario
    // would silently degrade into ordinary replay coverage.
    await expect(
      storeWithCreate.readWorkspaceBaseCurrency(CLIENT, WORKSPACE_ID),
    ).resolves.toBe('EUR');
    const readsBeforeReplay =
      storeWithCreate.readWorkspaceBaseCurrency.mock.calls.length;

    // Replay same key and same payload
    const second = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      { ...VALID_COMMAND, currency: 'USD' },
      IDEMPOTENCY_KEY,
    );
    expect(second).toEqual({
      kind: 'replayed',
      status: 201,
      etag: `"${createdAccount.version}"`,
      body: createdAccount,
    });
    expect(storeWithCreate.createAccount).toHaveBeenCalledTimes(1);
    // The replay short-circuits before the currency check, so the mutated
    // base currency is never consulted.
    expect(storeWithCreate.readWorkspaceBaseCurrency.mock.calls.length).toBe(
      readsBeforeReplay,
    );
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

describe('AccountsService.close', () => {
  const ACCOUNT_ID = '00000000-0000-0000-0000-000000000a01';
  const IDEMPOTENCY_KEY = '00000000-0000-0000-0000-000000000001';

  it('answers forbidden when the actor holds no active role in the workspace and never touches idempotency, account or transaction store', async () => {
    const store = fakeStore(undefined);
    const idempStore = fakeIdempotencyStore();
    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      undefined,
      idempStore,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.FORBIDDEN);
    expect(store.readActiveRole).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID);
    expect(idempStore.read).not.toHaveBeenCalled();
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(store.hasUnsettledTransactions).not.toHaveBeenCalled();
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('answers forbidden when the actor is a viewer and never touches account or transaction store', async () => {
    const store = fakeStore('viewer');
    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.FORBIDDEN);
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(store.hasUnsettledTransactions).not.toHaveBeenCalled();
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('replays response when a matching idempotency record already exists without touching account or transaction store', async () => {
    const closed = account({ id: ACCOUNT_ID, status: 'closed', version: 2 });
    const { computeRequestFingerprint } = await import(
      '../../src/platform/idempotency.service.js'
    );
    const fingerprint = computeRequestFingerprint({ accountId: ACCOUNT_ID });

    const store = fakeStore('owner');
    const idempStore = fakeIdempotencyStore({
      requestFingerprint: fingerprint,
      responseStatus: 200,
      responseEtag: null,
      responseBody: closed,
    });

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      undefined,
      idempStore,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_CLOSE_OUTCOMES.REPLAYED,
      status: 200,
      etag: null,
      body: closed,
    });
    expect(store.readAccount).not.toHaveBeenCalled();
    expect(store.hasUnsettledTransactions).not.toHaveBeenCalled();
    expect(store.closeAccount).not.toHaveBeenCalled();
    expect(idempStore.write).not.toHaveBeenCalled();
  });

  it('answers idempotency_conflict when an idempotency record exists with different fingerprint', async () => {
    const store = fakeStore('owner');
    const idempStore = fakeIdempotencyStore({
      requestFingerprint: 'different-fingerprint',
      responseStatus: 200,
      responseEtag: null,
      responseBody: {},
    });

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      undefined,
      idempStore,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.IDEMPOTENCY_CONFLICT);
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('answers not_found when the account does not exist in the workspace', async () => {
    const store = fakeStore('owner', [], undefined);
    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.NOT_FOUND);
    expect(store.readAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
    );
    expect(store.hasUnsettledTransactions).not.toHaveBeenCalled();
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('answers closed when the account exists but is already closed', async () => {
    const alreadyClosed = account({
      id: ACCOUNT_ID,
      status: 'closed',
      version: 3,
    });
    const store = fakeStore('owner', [], alreadyClosed);
    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.CLOSED);
    expect(store.hasUnsettledTransactions).not.toHaveBeenCalled();
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('answers version_conflict (412) when expectedVersions does not match account.version', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 2 });
    const store = fakeStore('owner', [], existing);
    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      1,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.VERSION_CONFLICT);
    expect(store.hasUnsettledTransactions).not.toHaveBeenCalled();
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('answers has_unsettled_transactions (409) when hasUnsettledTransactions returns true', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const store = fakeStore('owner', [], existing, undefined, undefined, {
      hasUnsettled: true,
    });

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      ACCOUNT_CLOSE_OUTCOMES.HAS_UNSETTLED_TRANSACTIONS,
    );
    expect(store.hasUnsettledTransactions).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
    );
    expect(store.closeAccount).not.toHaveBeenCalled();
  });

  it('RULING 30 negative test: closes account with non-zero balance and zero draft/pending transactions, asserting readAccountBalance is NEVER called', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1, status: 'active' });
    const closed = account({ id: ACCOUNT_ID, version: 2, status: 'closed' });
    const store = fakeStore('owner', [], existing, undefined, undefined, {
      singleBalance: balance({
        nativeBalance: { amountMinor: '50000', currency: 'USD' },
      }),
      hasUnsettled: false,
      closedAcc: closed,
    });
    const idempStore = fakeIdempotencyStore(undefined, true);

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      undefined,
      idempStore,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_CLOSE_OUTCOMES.OK,
      account: closed,
    });
    expect(store.hasUnsettledTransactions).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
    );
    expect(store.closeAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
      undefined,
    );
    // Explicit assertion: readAccountBalance is NEVER called
    expect(store.readAccountBalance).not.toHaveBeenCalled();
    expect(idempStore.write).toHaveBeenCalledWith(
      CLIENT,
      SUBJECT,
      'POST /v1/accounts/{accountId}/close',
      IDEMPOTENCY_KEY,
      expect.any(String),
      200,
      null,
      closed,
      WORKSPACE_ID,
    );
  });

  it('confirmed-only: closes account with confirmed/reconciled transactions (hasUnsettled=false)', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const closed = account({ id: ACCOUNT_ID, version: 2, status: 'closed' });
    const store = fakeStore('owner', [], existing, undefined, undefined, {
      hasUnsettled: false,
      closedAcc: closed,
    });

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_CLOSE_OUTCOMES.OK,
      account: closed,
    });
  });

  it('successfully closes account when expectedVersions matches current version', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const closed = account({ id: ACCOUNT_ID, version: 2, status: 'closed' });
    const store = fakeStore('owner', [], existing, undefined, undefined, {
      hasUnsettled: false,
      closedAcc: closed,
    });

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      1,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_CLOSE_OUTCOMES.OK,
      account: closed,
    });
    expect(store.closeAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      ACCOUNT_ID,
      1,
    );
  });

  it.each(['owner', 'administrator', 'editor'] as const)(
    'admits %s role for close',
    async (role) => {
      const existing = account({ id: ACCOUNT_ID, version: 1 });
      const closed = account({ id: ACCOUNT_ID, version: 2, status: 'closed' });
      const store = fakeStore(role, [], existing, undefined, undefined, {
        hasUnsettled: false,
        closedAcc: closed,
      });

      const outcome = await close(
        store,
        WORKSPACE_ID,
        ACCOUNT_ID,
        IDEMPOTENCY_KEY,
      );

      expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.OK);
    },
  );

  it('re-reads from idempotency store and returns replay when idempotency write loses race', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const closed = account({ id: ACCOUNT_ID, version: 2, status: 'closed' });
    const { computeRequestFingerprint } = await import(
      '../../src/platform/idempotency.service.js'
    );
    const fingerprint = computeRequestFingerprint({ accountId: ACCOUNT_ID });

    const store = fakeStore('owner', [], existing, undefined, undefined, {
      hasUnsettled: false,
      closedAcc: closed,
    });
    const idempStore: IdempotencyStore & { read: ReturnType<typeof vi.fn> } = {
      read: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        requestFingerprint: fingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: closed,
      }),
      write: vi.fn().mockResolvedValue(false),
    };

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      undefined,
      idempStore,
    );

    expect(outcome).toEqual({
      kind: ACCOUNT_CLOSE_OUTCOMES.REPLAYED,
      status: 200,
      etag: null,
      body: closed,
    });
    expect(idempStore.read).toHaveBeenCalledTimes(2);
  });

  it('answers idempotency_conflict when write loses race and winning record has different fingerprint', async () => {
    const existing = account({ id: ACCOUNT_ID, version: 1 });
    const closed = account({ id: ACCOUNT_ID, version: 2, status: 'closed' });

    const store = fakeStore('owner', [], existing, undefined, undefined, {
      hasUnsettled: false,
      closedAcc: closed,
    });
    const idempStore: IdempotencyStore & { read: ReturnType<typeof vi.fn> } = {
      read: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        requestFingerprint: 'different-fingerprint',
        responseStatus: 200,
        responseEtag: null,
        responseBody: {},
      }),
      write: vi.fn().mockResolvedValue(false),
    };

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      undefined,
      idempStore,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.IDEMPOTENCY_CONFLICT);
    expect(idempStore.read).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent version conflict when store.closeAccount returns undefined and account version changed', async () => {
    const initialAccount = account({ id: ACCOUNT_ID, version: 1 });
    const concurrentAccount = account({ id: ACCOUNT_ID, version: 2 });

    const store = fakeStore('owner');
    store.readAccount = vi
      .fn()
      .mockResolvedValueOnce(initialAccount)
      .mockResolvedValueOnce(concurrentAccount);
    store.closeAccount = vi.fn().mockResolvedValue(undefined);

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
      1,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.VERSION_CONFLICT);
    expect(store.readAccount).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent closure when store.closeAccount returns undefined and account became closed', async () => {
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
    store.closeAccount = vi.fn().mockResolvedValue(undefined);

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.CLOSED);
    expect(store.readAccount).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent deletion when store.closeAccount returns undefined and account was deleted', async () => {
    const initialAccount = account({ id: ACCOUNT_ID, version: 1 });

    const store = fakeStore('owner');
    store.readAccount = vi
      .fn()
      .mockResolvedValueOnce(initialAccount)
      .mockResolvedValueOnce(undefined);
    store.closeAccount = vi.fn().mockResolvedValue(undefined);

    const outcome = await close(
      store,
      WORKSPACE_ID,
      ACCOUNT_ID,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(ACCOUNT_CLOSE_OUTCOMES.NOT_FOUND);
    expect(store.readAccount).toHaveBeenCalledTimes(2);
  });
});
