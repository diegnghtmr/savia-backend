import { describe, expect, it, vi } from 'vitest';

import {
  TRANSACTION_CREATE_OUTCOMES,
  type CreateTransactionCommand,
  type Transaction,
} from '../../src/ledger/ledger.port.js';
import {
  TransactionService,
  type LedgerAccountRecord,
  type LedgerStore,
  type LedgerTransaction,
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
    transaction?: Transaction;
  } = {},
): LedgerStore & {
  readActiveRole: ReturnType<typeof vi.fn>;
  lockAndReadAccount: ReturnType<typeof vi.fn>;
  createTransaction: ReturnType<typeof vi.fn>;
} {
  const role = 'role' in options ? options.role : 'owner';
  const account = 'account' in options ? options.account : { status: 'active' };
  const transaction = options.transaction ?? sampleTransaction();
  return {
    readActiveRole: vi.fn().mockResolvedValue(role),
    lockAndReadAccount: vi.fn().mockResolvedValue(account),
    createTransaction: vi.fn().mockResolvedValue(transaction),
  };
}

describe('TransactionService.create', () => {
  const idempotencyKey = '00000000-0000-4000-8000-000000000001';

  it('refuses 403 when caller has no active membership role', async () => {
    const store = fakeStore({ role: undefined });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    expect(store.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses 403 when caller has viewer role (insufficient permissions for write)', async () => {
    const store = fakeStore({ role: 'viewer' });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
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

    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
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

    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );

    expect(outcome).toEqual({ kind: TRANSACTION_CREATE_OUTCOMES.FORBIDDEN });
    expect(outcome).not.toHaveProperty('body');
    expect(outcome).not.toHaveProperty('transaction');
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
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      command,
      idempotencyKey,
    );
    expect(outcome.kind).toBe(TRANSACTION_CREATE_OUTCOMES.REPLAYED);
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
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    });
    expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    expect(store.createTransaction).not.toHaveBeenCalled();
  });

  it('refuses ACCOUNT_UNRESOLVED when store reports account not found in workspace', async () => {
    const store = fakeStore({
      role: 'owner',
      account: undefined,
    });
    const idempotency = fakeIdempotencyStore();
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    });
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
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sampleCommand(),
      idempotencyKey,
    );

    expect(outcome).toEqual({
      kind: TRANSACTION_CREATE_OUTCOMES.ACCOUNT_CLOSED,
    });
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
    const service = new TransactionService(
      new FakeTransaction(),
      store,
      idempotency,
    );
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
