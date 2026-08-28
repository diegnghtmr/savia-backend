import { describe, expect, it, vi } from 'vitest';

import {
  TRANSACTION_CREATE_OUTCOMES,
  TRANSACTION_LIST_OUTCOMES,
  TRANSACTION_READ_OUTCOMES,
  TRANSACTION_UPDATE_OUTCOMES,
  TRANSACTION_VOID_OUTCOMES,
  type CreateTransactionCommand,
  type Transaction,
  type TransactionListQuery,
  type UpdateTransactionCommand,
  type VoidTransactionCommand,
} from '../../src/ledger/ledger.port.js';
import {
  TransactionService,
  type LedgerAccountRecord,
  type LedgerStore,
  type LedgerTransaction,
  type TransactionItem,
} from '../../src/ledger/transaction.service.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from '../../src/platform/idempotency.port.js';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';

const SUBJECT = '00000000-0000-0000-0000-000000000901';
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000951';

const CLIENT: TransactionClient = { query: vi.fn() };

class FakeTransaction implements LedgerTransaction {
  public readonly calls: ('run' | 'runRead')[] = [];

  public async run<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    this.calls.push('run');
    if (subject !== SUBJECT) throw new Error('unexpected subject');
    return callback(CLIENT);
  }

  public async runRead<T>(
    subject: string,
    callback: (client: TransactionClient) => Promise<T>,
  ): Promise<T> {
    this.calls.push('runRead');
    if (subject !== SUBJECT) throw new Error('unexpected subject');
    return callback(CLIENT);
  }
}

function sampleTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: '00000000-0000-0000-0000-000000000t01',
    type: 'expense',
    status: 'confirmed',
    accountId: '00000000-0000-0000-0000-000000000a01',
    amount: {
      amountMinor: '5000',
      currency: 'USD',
    },
    occurredAt: '2026-08-20T10:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: 'Groceries',
    notes: null,
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function sampleCommand(
  overrides: Partial<CreateTransactionCommand> = {},
): CreateTransactionCommand {
  return {
    type: 'expense',
    accountId: '00000000-0000-0000-0000-000000000a01',
    amount: {
      amountMinor: '5000',
      currency: 'USD',
    },
    occurredAt: '2026-08-20T10:00:00.000Z',
    status: 'confirmed',
    description: 'Groceries',
    ...overrides,
  };
}

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
  options: {
    role?: string | undefined;
    account?: LedgerAccountRecord | undefined;
    transaction?: Transaction | undefined;
    updatedTransaction?: Transaction | undefined;
    voidedTransaction?: Transaction | undefined;
    items?: readonly TransactionItem[];
  } = {},
): LedgerStore & {
  readActiveRole: ReturnType<typeof vi.fn>;
  lockAndReadAccount: ReturnType<typeof vi.fn>;
  createTransaction: ReturnType<typeof vi.fn>;
  readTransaction: ReturnType<typeof vi.fn>;
  listTransactions: ReturnType<typeof vi.fn>;
  updateTransaction: ReturnType<typeof vi.fn>;
  voidTransaction: ReturnType<typeof vi.fn>;
} {
  const role = 'role' in options ? options.role : 'owner';
  const account = 'account' in options ? options.account : { status: 'active' };
  const transaction =
    'transaction' in options ? options.transaction : sampleTransaction();
  const updatedTransaction =
    'updatedTransaction' in options
      ? options.updatedTransaction
      : transaction !== undefined
        ? { ...transaction, version: transaction.version + 1 }
        : undefined;
  const voidedTransaction =
    'voidedTransaction' in options
      ? options.voidedTransaction
      : transaction !== undefined
        ? { ...transaction, status: 'voided', version: transaction.version + 1 }
        : undefined;
  const items = options.items ?? [
    {
      transaction: transaction ?? sampleTransaction(),
      cursorAt: '2026-08-20T10:00:00.000000Z',
    },
  ];
  return {
    readActiveRole: vi.fn().mockResolvedValue(role),
    lockAndReadAccount: vi.fn().mockResolvedValue(account),
    createTransaction: vi.fn().mockResolvedValue(transaction),
    readTransaction: vi.fn().mockResolvedValue(transaction),
    listTransactions: vi.fn().mockResolvedValue(items),
    updateTransaction: vi.fn().mockResolvedValue(updatedTransaction),
    voidTransaction: vi.fn().mockResolvedValue(voidedTransaction),
  };
}

describe('TransactionService.create', () => {
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

  it('refuses 403 when caller has no active membership role', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    expect(store.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses 403 when caller has viewer role (insufficient permissions for write)', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'viewer' });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    expect(store.createTransaction).not.toHaveBeenCalled();
  });

  it('pins authorization ahead of idempotency read: refuses 403 without replaying when matching idempotency record exists for viewer', async () => {
    const callOrder: string[] = [];

    const store: LedgerStore = {
      readActiveRole: vi.fn().mockImplementation(async () => {
        callOrder.push('readActiveRole');
        return 'viewer';
      }),
      lockAndReadAccount: vi.fn(),
      createTransaction: vi.fn(),
      listTransactions: vi.fn(),
      readTransaction: vi.fn(),
      updateTransaction: vi.fn(),
      voidTransaction: vi.fn(),
    };

    const command = sampleCommand();
    const txn = sampleTransaction({ description: 'Secret financial data' });
    const idempotency: IdempotencyStore = {
      read: vi.fn().mockImplementation(async () => {
        callOrder.push('idempotencyStore.read');
        return {
          requestFingerprint: computeRequestFingerprint(command),
          responseStatus: 201,
          responseEtag: '"1"',
          responseBody: txn,
        };
      }),
      write: vi.fn().mockResolvedValue(true),
    };

    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readActiveRole).toHaveBeenCalledTimes(1);
    expect(idempotency.read).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['readActiveRole']);
  });

  it('pins authorization ahead of idempotency read: refuses 403 without replaying when matching idempotency record exists for non-member', async () => {
    const callOrder: string[] = [];

    const store: LedgerStore = {
      readActiveRole: vi.fn().mockImplementation(async () => {
        callOrder.push('readActiveRole');
        return undefined;
      }),
      lockAndReadAccount: vi.fn(),
      createTransaction: vi.fn(),
      listTransactions: vi.fn(),
      readTransaction: vi.fn(),
      updateTransaction: vi.fn(),
      voidTransaction: vi.fn(),
    };

    const command = sampleCommand();
    const txn = sampleTransaction({ description: 'Secret financial data' });
    const idempotency: IdempotencyStore = {
      read: vi.fn().mockImplementation(async () => {
        callOrder.push('idempotencyStore.read');
        return {
          requestFingerprint: computeRequestFingerprint(command),
          responseStatus: 201,
          responseEtag: '"1"',
          responseBody: txn,
        };
      }),
      write: vi.fn().mockResolvedValue(true),
    };

    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readActiveRole).toHaveBeenCalledTimes(1);
    expect(idempotency.read).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['readActiveRole']);
  });

  it('replays stored response when idempotency key is matched with identical fingerprint', async () => {
    const txn = sampleTransaction();
    const store = fakeStore({ role: 'editor' });
    const command = sampleCommand();
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: computeRequestFingerprint(command),
      responseStatus: 201,
      responseEtag: '"1"',
      responseBody: txn,
    });
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );
    expect(outcome.kind).toBe(TRANSACTION_CREATE_OUTCOMES.REPLAYED);
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    expect(store.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses 409 conflict when idempotency key is reused with different payload', async () => {
    const store = fakeStore({ role: 'owner' });
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: 'different-fingerprint',
      responseStatus: 201,
      responseEtag: '"1"',
      responseBody: {},
    });
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    expect(store.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses ACCOUNT_UNRESOLVED when store reports account not found in workspace', async () => {
    const store = fakeStore({
      role: 'owner',
      account: undefined,
    });
    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      '00000000-0000-0000-0000-000000000a01',
    );
    expect(store.createTransaction).not.toHaveBeenCalled();
    expect(idempotency.write).not.toHaveBeenCalled();
  });

  it('refuses ACCOUNT_CLOSED when store reports account status is closed', async () => {
    const store = fakeStore({
      role: 'owner',
      account: { status: 'closed' },
    });
    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      '00000000-0000-0000-0000-000000000a01',
    );
    expect(store.createTransaction).not.toHaveBeenCalled();
    expect(idempotency.write).not.toHaveBeenCalled();
  });

  it('creates transaction, records idempotency and returns CREATED outcome', async () => {
    const txn = sampleTransaction();
    const store = fakeStore({
      role: 'owner',
      account: { status: 'active' },
      transaction: txn,
    });
    const idempotency = fakeIdempotencyStore(undefined, true);
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);
    const command = sampleCommand();

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.CREATED,
      transaction: txn,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.lockAndReadAccount).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      command.accountId,
    );
    expect(store.createTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      SUBJECT,
      command,
    );
    expect(idempotency.write).toHaveBeenCalledWith(
      CLIENT,
      SUBJECT,
      'POST /v1/transactions',
      idempotencyKey,
      expect.any(String),
      201,
      '"1"',
      txn,
      WORKSPACE_ID,
    );
  });
});

describe('TransactionService.read', () => {
  const transactionId = '00000000-0000-0000-0000-000000000t01';

  it('refuses 403 when caller has no active membership role before any store read', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.read(SUBJECT, WORKSPACE_ID, transactionId);

    expect(outcome).toEqual({ kind: TRANSACTION_READ_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['runRead']);
    expect(store.readTransaction).not.toHaveBeenCalled();
  });

  it('returns 404 when transaction is not found in workspace', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner' });
    store.readTransaction.mockResolvedValue(undefined);
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.read(SUBJECT, WORKSPACE_ID, transactionId);

    expect(outcome).toEqual({ kind: TRANSACTION_READ_OUTCOMES.NOT_FOUND });
    expect(fakeTransaction.calls).toEqual(['runRead']);
    expect(store.readTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      transactionId,
    );
  });

  it('returns 200 with transaction when found', async () => {
    const fakeTransaction = new FakeTransaction();
    const txn = sampleTransaction({ id: transactionId });
    const store = fakeStore({ role: 'owner', transaction: txn });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.read(SUBJECT, WORKSPACE_ID, transactionId);

    expect(outcome).toEqual({
      kind: TRANSACTION_READ_OUTCOMES.OK,
      transaction: txn,
    });
    expect(fakeTransaction.calls).toEqual(['runRead']);
    expect(store.readTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      transactionId,
    );
  });

  it('admits a viewer because read operations require only an active membership role', async () => {
    const fakeTransaction = new FakeTransaction();
    const txn = sampleTransaction({ id: transactionId });
    const store = fakeStore({ role: 'viewer', transaction: txn });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.read(SUBJECT, WORKSPACE_ID, transactionId);

    expect(outcome).toEqual({
      kind: TRANSACTION_READ_OUTCOMES.OK,
      transaction: txn,
    });
    expect(fakeTransaction.calls).toEqual(['runRead']);
  });
});

describe('TransactionService.list', () => {
  const query: TransactionListQuery = {
    workspaceId: WORKSPACE_ID,
    limit: 2,
    accountId: '00000000-0000-0000-0000-000000000a01',
    from: '2026-08-01',
    to: '2026-08-31',
    categoryId: '00000000-0000-0000-0000-000000000c01',
    status: 'confirmed',
    query: 'Coffee',
  };

  it('refuses 403 when caller has no active membership role before any store read', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.list(SUBJECT, query);

    expect(outcome).toEqual({ kind: TRANSACTION_LIST_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['runRead']);
    expect(store.listTransactions).not.toHaveBeenCalled();
  });

  it('admits a viewer because read operations require only an active membership role', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'viewer' });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.list(SUBJECT, query);

    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    expect(fakeTransaction.calls).toEqual(['runRead']);
  });

  it('threads query object and filters to the store unchanged with limit + 1', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner' });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    await service.list(SUBJECT, query);

    expect(store.listTransactions).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      undefined,
      3, // limit + 1
      {
        accountId: query.accountId,
        from: query.from,
        to: query.to,
        categoryId: query.categoryId,
        status: query.status,
        query: query.query,
      },
    );
  });

  it('returns page with hasNextPage true and nextCursor when store returns more rows than limit', async () => {
    const txn1 = sampleTransaction({
      id: '00000000-0000-0000-0000-000000000001',
    });
    const txn2 = sampleTransaction({
      id: '00000000-0000-0000-0000-000000000002',
    });
    const txn3 = sampleTransaction({
      id: '00000000-0000-0000-0000-000000000003',
    });

    const items: TransactionItem[] = [
      { transaction: txn1, cursorAt: '2026-08-25T12:00:00.000000Z' },
      { transaction: txn2, cursorAt: '2026-08-24T10:00:00.000000Z' },
      { transaction: txn3, cursorAt: '2026-08-23T08:00:00.000000Z' },
    ];

    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', items });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.list(SUBJECT, query);

    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (outcome.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;

    expect(outcome.page.items).toEqual([txn1, txn2]);
    expect(outcome.page.pageInfo.hasNextPage).toBe(true);
    expect(outcome.page.pageInfo.nextCursor).not.toBeNull();
  });

  it('returns page with hasNextPage false and nextCursor null when store returns rows <= limit', async () => {
    const txn1 = sampleTransaction({
      id: '00000000-0000-0000-0000-000000000001',
    });

    const items: TransactionItem[] = [
      { transaction: txn1, cursorAt: '2026-08-25T12:00:00.000000Z' },
    ];

    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', items });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.list(SUBJECT, query);

    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (outcome.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;

    expect(outcome.page.items).toEqual([txn1]);
    expect(outcome.page.pageInfo.hasNextPage).toBe(false);
    expect(outcome.page.pageInfo.nextCursor).toBeNull();
  });
});

describe('TransactionService.update', () => {
  const transactionId = '00000000-0000-0000-0000-000000000t01';
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';
  const updateCommand: UpdateTransactionCommand = {
    description: 'Updated Description',
    status: 'pending',
  };

  it('refuses 403 when caller has no active membership role', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('refuses 403 when caller has viewer role (insufficient permissions for write)', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'viewer' });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('pins authorization ahead of idempotency read: refuses 403 without replaying when matching idempotency record exists for viewer', async () => {
    const callOrder: string[] = [];

    const store = fakeStore({
      role: 'viewer',
    });
    store.readActiveRole.mockImplementation(async () => {
      callOrder.push('readActiveRole');
      return 'viewer';
    });

    const txn = sampleTransaction({ description: 'Secret updated data' });
    const idempotency: IdempotencyStore = {
      read: vi.fn().mockImplementation(async () => {
        callOrder.push('idempotencyStore.read');
        return {
          requestFingerprint: computeRequestFingerprint({
            transactionId,
            ...updateCommand,
          }),
          responseStatus: 200,
          responseEtag: '"2"',
          responseBody: txn,
        };
      }),
      write: vi.fn().mockResolvedValue(true),
    };

    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN });
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readActiveRole).toHaveBeenCalledTimes(1);
    expect(idempotency.read).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['readActiveRole']);
  });

  it('pins authorization ahead of idempotency read: refuses 403 without replaying when matching idempotency record exists for non-member', async () => {
    const callOrder: string[] = [];

    const store = fakeStore({
      role: undefined,
    });
    store.readActiveRole.mockImplementation(async () => {
      callOrder.push('readActiveRole');
      return undefined;
    });

    const txn = sampleTransaction({ description: 'Secret updated data' });
    const idempotency: IdempotencyStore = {
      read: vi.fn().mockImplementation(async () => {
        callOrder.push('idempotencyStore.read');
        return {
          requestFingerprint: computeRequestFingerprint({
            transactionId,
            ...updateCommand,
          }),
          responseStatus: 200,
          responseEtag: '"2"',
          responseBody: txn,
        };
      }),
      write: vi.fn().mockResolvedValue(true),
    };

    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_UPDATE_OUTCOMES.FORBIDDEN });
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readActiveRole).toHaveBeenCalledTimes(1);
    expect(idempotency.read).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['readActiveRole']);
  });

  it('replays stored response when idempotency key is matched with identical fingerprint', async () => {
    const txn = sampleTransaction({ version: 2 });
    const store = fakeStore({ role: 'editor' });
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: computeRequestFingerprint({
        transactionId,
        ...updateCommand,
      }),
      responseStatus: 200,
      responseEtag: '"2"',
      responseBody: txn,
    });
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.REPLAYED,
      status: 200,
      etag: '"2"',
      body: txn,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('refuses 409 conflict when idempotency key is reused with different payload', async () => {
    const store = fakeStore({ role: 'owner' });
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: 'different-fingerprint',
      responseStatus: 200,
      responseEtag: '"2"',
      responseBody: {},
    });
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND (404) when transaction is not found in workspace', async () => {
    const store = fakeStore({
      role: 'owner',
      transaction: undefined,
    });
    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      transactionId,
    );
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('returns VOIDED (409) when existing transaction status is voided: voided transactions cannot be modified', async () => {
    const voidedTxn = sampleTransaction({ status: 'voided' });
    const store = fakeStore({
      role: 'owner',
      transaction: voidedTxn,
    });
    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.VOIDED,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('returns RECONCILED (409) when existing transaction status is reconciled: reconciled transactions refuse modification', async () => {
    const reconciledTxn = sampleTransaction({ status: 'reconciled' });
    const store = fakeStore({
      role: 'owner',
      transaction: reconciledTxn,
    });
    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.RECONCILED,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('returns VERSION_CONFLICT (412) when expectedVersions does not match existing version in pre-check', async () => {
    const existingTxn = sampleTransaction({ version: 2 });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
    });
    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
      1, // Stale version 1
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.updateTransaction).not.toHaveBeenCalled();
  });

  it('updates transaction, records idempotency and returns OK outcome', async () => {
    const existingTxn = sampleTransaction({ version: 1 });
    const updatedTxn = sampleTransaction({
      version: 2,
      description: 'Updated Description',
      status: 'pending',
    });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      updatedTransaction: updatedTxn,
    });
    const idempotency = fakeIdempotencyStore(undefined, true);
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
      1,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.OK,
      transaction: updatedTxn,
    });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.updateTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      1,
    );
    expect(idempotency.write).toHaveBeenCalledWith(
      CLIENT,
      SUBJECT,
      'PATCH /v1/transactions/{transactionId}',
      idempotencyKey,
      expect.any(String),
      200,
      '"2"',
      updatedTxn,
      WORKSPACE_ID,
    );
  });

  it('handles zero-row update with re-read distinguishing concurrent version conflict (412)', async () => {
    const existingTxn = sampleTransaction({ version: 1 });
    const rereadTxn = sampleTransaction({ version: 2 }); // Concurrently bumped
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      updatedTransaction: undefined, // zero-row update
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn) // Pre-read
      .mockResolvedValueOnce(rereadTxn); // Zero-row re-read

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
      1,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.VERSION_CONFLICT,
    });
  });

  it('handles zero-row update with re-read distinguishing mid-transaction deletion (404)', async () => {
    const existingTxn = sampleTransaction({ version: 1 });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      updatedTransaction: undefined,
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(undefined); // Deleted

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.NOT_FOUND,
    });
  });

  it('handles zero-row update with re-read distinguishing mid-transaction voiding (403)', async () => {
    const existingTxn = sampleTransaction({ version: 1 });
    const voidedTxn = sampleTransaction({ version: 2, status: 'voided' });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      updatedTransaction: undefined,
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(voidedTxn);

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.update(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      updateCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_UPDATE_OUTCOMES.VOIDED,
    });
  });
});

describe('TransactionService.void', () => {
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';
  const transactionId = '00000000-0000-0000-0000-000000000t01';
  const voidCommand: VoidTransactionCommand = {
    reason: 'Voided due to customer return',
  };

  it('refuses 403 when caller has no active membership role', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.FORBIDDEN });
    expect(fakeTransaction.calls).toEqual(['run']);
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 403 when caller is a viewer', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'viewer' });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.FORBIDDEN });
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('pins authorization ahead of idempotency read on void with matching stored record', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'viewer' });
    const fingerprint = computeRequestFingerprint({
      transactionId,
      ...voidCommand,
    });
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: fingerprint,
      responseStatus: 200,
      responseEtag: null,
      responseBody: sampleTransaction({ status: 'voided' }),
    });
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.FORBIDDEN });
    expect(idempotency.read).not.toHaveBeenCalled();
  });

  it('replays stored 200 response on matching idempotency record', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner' });
    const voidedTxn = sampleTransaction({ status: 'voided', version: 2 });
    const fingerprint = computeRequestFingerprint({
      transactionId,
      ...voidCommand,
    });
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: fingerprint,
      responseStatus: 200,
      responseEtag: null,
      responseBody: voidedTxn,
    });
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.REPLAYED,
      status: 200,
      etag: null,
      body: voidedTxn,
    });
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 409 conflict when idempotency key is reused with different payload', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner' });
    const idempotency = fakeIdempotencyStore({
      requestFingerprint: 'different-fingerprint-sha256',
      responseStatus: 200,
      responseEtag: null,
      responseBody: sampleTransaction({ status: 'voided' }),
    });
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.IDEMPOTENCY_CONFLICT,
    });
    expect(store.readTransaction).not.toHaveBeenCalled();
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 404 when transaction does not exist in workspace', async () => {
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', transaction: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.NOT_FOUND });
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 409 (DRAFT) when transaction is in draft status', async () => {
    const draftTxn = sampleTransaction({ status: 'draft' });
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', transaction: draftTxn });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.DRAFT });
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 409 (VOIDED) when transaction is already voided (even with a NEW idempotency key)', async () => {
    const voidedTxn = sampleTransaction({ status: 'voided' });
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', transaction: voidedTxn });
    const idempotency = fakeIdempotencyStore(); // No matching idempotency record
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      '00000000-0000-4000-8000-999999999999', // Fresh key
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.VOIDED });
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 409 (RECONCILED) when transaction is reconciled', async () => {
    const reconciledTxn = sampleTransaction({ status: 'reconciled' });
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', transaction: reconciledTxn });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_VOID_OUTCOMES.RECONCILED });
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('refuses 412 (VERSION_CONFLICT) on expected version mismatch in pre-check', async () => {
    const existingTxn = sampleTransaction({ version: 1 });
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({ role: 'owner', transaction: existingTxn });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
      99, // Expected 99 vs actual 1
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT,
    });
    expect(store.voidTransaction).not.toHaveBeenCalled();
  });

  it('proceeds on confirmed transaction, writes idempotency record, and returns 200 OK', async () => {
    const existingTxn = sampleTransaction({ status: 'confirmed', version: 1 });
    const voidedTxn = sampleTransaction({ status: 'voided', version: 2 });
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      voidedTransaction: voidedTxn,
    });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
      1,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.OK,
      transaction: voidedTxn,
    });
    expect(store.voidTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      transactionId,
      existingTxn.accountId,
      'confirmed',
      1,
    );
    expect(idempotency.write).toHaveBeenCalledWith(
      CLIENT,
      SUBJECT,
      'POST /v1/transactions/{transactionId}/void',
      idempotencyKey,
      expect.any(String),
      200,
      null,
      voidedTxn,
      WORKSPACE_ID,
    );
  });

  it('proceeds on pending transaction and returns 200 OK', async () => {
    const existingTxn = sampleTransaction({ status: 'pending', version: 1 });
    const voidedTxn = sampleTransaction({ status: 'voided', version: 2 });
    const fakeTransaction = new FakeTransaction();
    const store = fakeStore({
      role: 'administrator',
      transaction: existingTxn,
      voidedTransaction: voidedTxn,
    });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.OK,
      transaction: voidedTxn,
    });
    expect(store.voidTransaction).toHaveBeenCalledWith(
      CLIENT,
      WORKSPACE_ID,
      transactionId,
      existingTxn.accountId,
      'pending',
      1,
    );
  });

  it('handles zero-row void with re-read distinguishing concurrent version conflict (412)', async () => {
    const existingTxn = sampleTransaction({ status: 'confirmed', version: 1 });
    const rereadTxn = sampleTransaction({ status: 'confirmed', version: 2 });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      voidedTransaction: undefined, // zero-row void
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(rereadTxn);

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
      1,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.VERSION_CONFLICT,
    });
  });

  it('handles zero-row void with re-read distinguishing mid-transaction voiding (409 VOIDED)', async () => {
    const existingTxn = sampleTransaction({ status: 'confirmed', version: 1 });
    const voidedTxn = sampleTransaction({ status: 'voided', version: 2 });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      voidedTransaction: undefined,
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(voidedTxn);

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.VOIDED,
    });
  });

  it('handles zero-row void with re-read distinguishing mid-transaction reconciliation (409 RECONCILED)', async () => {
    const existingTxn = sampleTransaction({ status: 'confirmed', version: 1 });
    const reconciledTxn = sampleTransaction({
      status: 'reconciled',
      version: 2,
    });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      voidedTransaction: undefined,
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(reconciledTxn);

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.RECONCILED,
    });
  });

  it('handles zero-row void with re-read distinguishing mid-transaction draft status (409 DRAFT)', async () => {
    const existingTxn = sampleTransaction({ status: 'confirmed', version: 1 });
    const draftTxn = sampleTransaction({ status: 'draft', version: 2 });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      voidedTransaction: undefined,
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(draftTxn);

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.DRAFT,
    });
  });

  it('handles zero-row void with re-read distinguishing deletion (404 NOT_FOUND)', async () => {
    const existingTxn = sampleTransaction({ status: 'confirmed', version: 1 });
    const store = fakeStore({
      role: 'owner',
      transaction: existingTxn,
      voidedTransaction: undefined,
    });
    store.readTransaction
      .mockResolvedValueOnce(existingTxn)
      .mockResolvedValueOnce(undefined);

    const idempotency = fakeIdempotencyStore();
    const fakeTransaction = new FakeTransaction();
    const service = new TransactionService(fakeTransaction, store, idempotency);

    const outcome = await service.void(
      SUBJECT,
      WORKSPACE_ID,
      transactionId,
      voidCommand,
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_VOID_OUTCOMES.NOT_FOUND,
    });
  });
});
