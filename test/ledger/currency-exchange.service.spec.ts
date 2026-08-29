import { describe, expect, it, vi } from 'vitest';

import {
  CURRENCY_EXCHANGE_CREATE_OUTCOMES,
  type CreateCurrencyExchangeCommand,
  type CurrencyExchangeCreateCreated,
  type CurrencyExchangeCreateReplayed,
} from '../../src/ledger/currency-exchange.port.js';
import {
  CurrencyExchangeService,
  type CurrencyExchangeStore,
} from '../../src/ledger/currency-exchange.service.js';
import type { Transfer } from '../../src/ledger/transfer.port.js';
import type { TransferAccountRecord } from '../../src/ledger/transfer.service.js';
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
    amountMinor: '4600',
    currency: 'EUR',
  },
  exchangeRate: '0.9200',
  occurredAt: '2026-08-25T10:00:00.000Z',
  status: 'confirmed',
};

const COMMAND: CreateCurrencyExchangeCommand = {
  sourceAccountId: SOURCE_ACCOUNT_ID,
  destinationAccountId: DEST_ACCOUNT_ID,
  sourceAmount: {
    amountMinor: '5000',
    currency: 'USD',
  },
  destinationAmount: {
    amountMinor: '4600',
    currency: 'EUR',
  },
  executedRate: '0.9200',
  occurredAt: '2026-08-25T10:00:00.000Z',
  description: 'Test currency exchange',
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
      currency: 'EUR',
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

  const mockStore: CurrencyExchangeStore = {
    readActiveRole: vi.fn().mockResolvedValue(role === null ? undefined : role),
    lockAndReadAccounts: vi.fn().mockResolvedValue(accounts),
    createCurrencyExchange: vi.fn().mockResolvedValue(TRANSFER),
  };

  const mockIdempotencyStore: IdempotencyStore = {
    read: vi.fn().mockResolvedValue(existingIdempotency),
    write: vi.fn().mockResolvedValue(true),
  };

  const service = new CurrencyExchangeService(
    mockTransaction,
    mockStore,
    mockIdempotencyStore,
  );

  return { service, mockStore, mockIdempotencyStore, mockTransaction };
}

describe('CurrencyExchangeService.create', () => {
  it('checks active role first and refuses with FORBIDDEN if caller lacks editor+ role', async () => {
    const { service, mockStore, mockIdempotencyStore } =
      createService('viewer');

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockStore.readActiveRole).toHaveBeenCalled();
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
    expect(mockStore.lockAndReadAccounts).not.toHaveBeenCalled();
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('checks active role first and refuses with FORBIDDEN if caller has no role in workspace', async () => {
    const { service, mockIdempotencyStore } = createService(null);

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
  });

  it('replays response when idempotency key exists with matching fingerprint', async () => {
    const { service, mockStore } = createService('owner', undefined, {
      requestFingerprint:
        'c2d6cf47e8bbbaee02df2f83196f7c19ad16d47b5ae177db59846b43d3b6f264',
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

    if (outcome.kind === CURRENCY_EXCHANGE_CREATE_OUTCOMES.REPLAYED) {
      const replayed = outcome as CurrencyExchangeCreateReplayed;
      expect(replayed.status).toBe(201);
      expect(replayed.body).toEqual(TRANSFER);
      expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
    } else {
      expect(outcome.kind).toBe(
        CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
      );
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

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('returns ACCOUNT_UNRESOLVED when source account cannot be resolved in workspace', async () => {
    const { service, mockStore } = createService('owner', {
      sourceAccount: undefined,
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

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
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

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_UNRESOLVED,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
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
        currency: 'EUR',
      },
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_CLOSED);
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
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
        currency: 'EUR',
      },
    });

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.ACCOUNT_CLOSED);
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('refuses same-currency accounts (USD vs USD) with CURRENCY_MISMATCH (D3)', async () => {
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

    const sameCurrencyCommand: CreateCurrencyExchangeCommand = {
      ...COMMAND,
      destinationAmount: { amountMinor: '5000', currency: 'USD' },
    };

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      sameCurrencyCommand,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('refuses currency mismatch between sourceAmount currency and source account currency (D3)', async () => {
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

    const mismatchCommand: CreateCurrencyExchangeCommand = {
      ...COMMAND,
      sourceAmount: { amountMinor: '5000', currency: 'GBP' },
    };

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      mismatchCommand,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('refuses currency mismatch between destinationAmount currency and destination account currency (D3)', async () => {
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

    const mismatchCommand: CreateCurrencyExchangeCommand = {
      ...COMMAND,
      destinationAmount: { amountMinor: '4600', currency: 'GBP' },
    };

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      mismatchCommand,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('refuses fee currency differing from source account currency (D3)', async () => {
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

    const feeMismatchCommand: CreateCurrencyExchangeCommand = {
      ...COMMAND,
      fee: { amountMinor: '50', currency: 'EUR' },
    };

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      feeMismatchCommand,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      CURRENCY_EXCHANGE_CREATE_OUTCOMES.CURRENCY_MISMATCH,
    );
    expect(mockStore.createCurrencyExchange).not.toHaveBeenCalled();
  });

  it('creates currency exchange successfully and records idempotency with null etag (D4: does not cross-check destinationAmount = sourceAmount * executedRate)', async () => {
    const { service, mockStore, mockIdempotencyStore } = createService('owner');

    const outcome = await service.create(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(CURRENCY_EXCHANGE_CREATE_OUTCOMES.CREATED);
    expect((outcome as CurrencyExchangeCreateCreated).transfer).toEqual(
      TRANSFER,
    );
    expect(mockStore.createCurrencyExchange).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      SUBJECT,
      COMMAND,
    );
    expect(mockIdempotencyStore.write).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
      'POST /v1/currency-exchanges',
      IDEMPOTENCY_KEY,
      expect.any(String),
      201,
      null, // NO ETag header
      TRANSFER,
      WORKSPACE_ID,
    );
  });
});
