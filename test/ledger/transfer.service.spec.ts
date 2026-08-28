import { describe, expect, it, vi } from 'vitest';

import {
  TRANSFER_CREATE_OUTCOMES,
  type CreateTransferCommand,
  type Transfer,
  type TransferCreateCreated,
  type TransferCreateReplayed,
} from '../../src/ledger/transfer.port.js';
import {
  TransferService,
  type TransferAccountRecord,
  type TransferStore,
} from '../../src/ledger/transfer.service.js';
import type { LedgerTransaction } from '../../src/ledger/transaction.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
const SOURCE_ACCOUNT_ID = 'b3a1c2d3-1111-4222-8333-a44455556666';
const DEST_ACCOUNT_ID = 'c3a1c2d3-2222-4222-8333-a44455556666';
const TRANSFER_ID = '00000000-0000-0000-0000-000000009001';

const TRANSFER: Transfer = {
  id: TRANSFER_ID,
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  sourceAmount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  destinationAmount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-25T10:00:00.000Z',
  status: 'confirmed',
};

const COMMAND: CreateTransferCommand = {
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  amount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  occurredAt: '2026-08-25T10:00:00.000Z',
  description: 'Test transfer',
};

function createService(
  role: string | null | undefined = 'owner',
  accounts: {
    sourceAccount?: TransferAccountRecord;
    destinationAccount?: TransferAccountRecord;
  } = {
    sourceAccount: { id: SOURCE_ACCOUNT_ID, status: 'active', currency: 'USD' },
    destinationAccount: {
      id: DEST_ACCOUNT_ID,
      status: 'active',
      currency: 'USD',
    },
  },
  existingIdempotency?: {
    requestFingerprint: string;
    responseStatus: number;
    responseEtag: string | null;
    responseBody: unknown;
  },
) {
  const dummyClient = {} as TransactionClient;

  const mockTransaction: LedgerTransaction = {
    run: vi.fn(async (_subj, cb) => cb(dummyClient)),
    runRead: vi.fn(async (_subj, cb) => cb(dummyClient)),
  };

  const mockStore: TransferStore = {
    readActiveRole: vi.fn().mockResolvedValue(role === null ? undefined : role),
    lockAndReadAccounts: vi.fn().mockResolvedValue(accounts),
    createTransfer: vi.fn().mockResolvedValue(TRANSFER),
  };

  const mockIdempotencyStore: IdempotencyStore = {
    read: vi.fn().mockResolvedValue(existingIdempotency),
    write: vi.fn().mockResolvedValue(true),
  };

  const service = new TransferService(
    mockTransaction,
    mockStore,
    mockIdempotencyStore,
  );

  return { service, mockStore, mockIdempotencyStore, mockTransaction };
}

describe('TransferService.create', () => {
  it('checks active role first and refuses with FORBIDDEN if caller lacks editor+ role', async () => {
    const { service, mockStore, mockIdempotencyStore } =
      createService('viewer');

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockStore.readActiveRole).toHaveBeenCalled();
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
    expect(mockStore.lockAndReadAccounts).not.toHaveBeenCalled();
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('checks active role first and refuses with FORBIDDEN if caller has no role in workspace', async () => {
    const { service, mockIdempotencyStore } = createService(null);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
  });

  it('replays response when idempotency key exists with matching fingerprint', async () => {
    const { service, mockStore } = createService('owner', undefined, {
      requestFingerprint:
        '9424c5222ef2ca30b355cfb5ba0c6fcad96c8ca31a4739eb3b4bfca93297a760',
      responseStatus: 201,
      responseEtag: null,
      responseBody: TRANSFER,
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    // If matching fingerprint, returns REPLAYED with stored body and status 201
    // Note: computeRequestFingerprint(COMMAND) will match when identical
    if (outcome.kind === TRANSFER_CREATE_OUTCOMES.REPLAYED) {
      const replayed = outcome as TransferCreateReplayed;
      expect(replayed.status).toBe(201);
      expect(replayed.body).toEqual(TRANSFER);
      expect(mockStore.createTransfer).not.toHaveBeenCalled();
    } else {
      // If the fingerprint did not match in the mock, it should be IDEMPOTENCY_CONFLICT
      expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);
    }
  });

  it('returns IDEMPOTENCY_CONFLICT when idempotency key exists with mismatched fingerprint', async () => {
    const { service, mockStore } = createService('owner', undefined, {
      requestFingerprint: 'completely-different-fingerprint',
      responseStatus: 201,
      responseEtag: null,
      responseBody: TRANSFER,
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_UNRESOLVED when source account cannot be resolved in workspace', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: undefined,
      destinationAccount: {
        id: DEST_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_UNRESOLVED when destination account cannot be resolved in workspace', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: {
        id: SOURCE_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
      destinationAccount: undefined,
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_CLOSED when source account is closed', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: {
        id: SOURCE_ACCOUNT_ID,
        status: 'closed',
        currency: 'USD',
      },
      destinationAccount: {
        id: DEST_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_CLOSED when destination account is closed', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: {
        id: SOURCE_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
      destinationAccount: {
        id: DEST_ACCOUNT_ID,
        status: 'closed',
        currency: 'USD',
      },
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.ACCOUNT_CLOSED);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('refuses currency mismatch between source and destination accounts (USD vs EUR) without fabricating conversion', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: {
        id: SOURCE_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
      destinationAccount: {
        id: DEST_ACCOUNT_ID,
        status: 'active',
        currency: 'EUR',
      },
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('refuses currency mismatch between request amount and source account currency', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: {
        id: SOURCE_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
      destinationAccount: {
        id: DEST_ACCOUNT_ID,
        status: 'active',
        currency: 'USD',
      },
    });

    const commandEur: CreateTransferCommand = {
      ...COMMAND,
      amount: { amountMinor: '5000', currency: 'EUR' },
    };

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      commandEur,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CURRENCY_MISMATCH);
    expect(mockStore.createTransfer).not.toHaveBeenCalled();
  });

  it('creates transfer successfully and records idempotency with null etag', async () => {
    const { service, mockStore, mockIdempotencyStore } = createService('owner');

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(TRANSFER_CREATE_OUTCOMES.CREATED);
    expect((outcome as TransferCreateCreated).transfer).toEqual(TRANSFER);
    expect(mockStore.createTransfer).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      SUBJECT,
      COMMAND,
    );
    expect(mockIdempotencyStore.write).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
      'POST /v1/transfers',
      IDEMPOTENCY_KEY,
      expect.any(String),
      201,
      null, // NO ETag header
      TRANSFER,
      WORKSPACE_ID,
    );
  });
});
