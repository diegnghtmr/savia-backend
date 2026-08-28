import { describe, expect, it, vi } from 'vitest';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';

import {
  EXCHANGE_RATE_CREATE_OUTCOMES,
  type CreateManualExchangeRateCommand,
  type ExchangeRate,
  type ExchangeRateCreateCreated,
  type ExchangeRateCreateReplayed,
} from '../../src/currencies/exchange-rate.port.js';
import {
  ExchangeRateAlreadyRecordedError,
  ExchangeRateService,
  type CurrenciesTransaction,
  type ExchangeRateStore,
} from '../../src/currencies/exchange-rate.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

const SUBJECT = '3f1d9d0a-2b4c-4a1e-9c7d-5e8f0a1b2c3d';
const WORKSPACE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEMPOTENCY_KEY = 'a0000000-0000-0000-0000-000000000001';
const EXCHANGE_RATE_ID = '00000000-0000-0000-0000-000000009001';

const EXCHANGE_RATE: ExchangeRate = {
  id: EXCHANGE_RATE_ID,
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: '0.9200',
  effectiveAt: '2026-08-28T12:00:00.000Z',
  source: 'manual',
  manual: true,
};

const COMMAND: CreateManualExchangeRateCommand = {
  baseCurrency: 'USD',
  quoteCurrency: 'EUR',
  rate: '0.9200',
  effectiveAt: '2026-08-28T12:00:00.000Z',
  notes: 'Test manual exchange rate',
};

function createService(
  role: string | null | undefined = 'owner',
  existingIdempotency?: {
    requestFingerprint: string;
    responseStatus: number;
    responseEtag: string | null;
    responseBody: unknown;
  },
  storeError?: Error,
) {
  const dummyClient = {} as TransactionClient;

  const mockTransaction: CurrenciesTransaction = {
    run: vi.fn(async (_subj, cb) => cb(dummyClient)),
    runRead: vi.fn(async (_subj, cb) => cb(dummyClient)),
  };

  const mockStore: ExchangeRateStore = {
    readActiveRole: vi.fn().mockResolvedValue(role === null ? undefined : role),
    createManualExchangeRate: storeError
      ? vi.fn().mockRejectedValue(storeError)
      : vi.fn().mockResolvedValue(EXCHANGE_RATE),
  };

  const mockIdempotencyStore: IdempotencyStore = {
    read: vi.fn().mockResolvedValue(existingIdempotency),
    write: vi.fn().mockResolvedValue(true),
  };

  const service = new ExchangeRateService(
    mockTransaction,
    mockStore,
    mockIdempotencyStore,
  );

  return { service, mockStore, mockIdempotencyStore, mockTransaction };
}

describe('ExchangeRateService.createManual', () => {
  it('checks active role first and refuses with FORBIDDEN if caller lacks editor+ role', async () => {
    const { service, mockStore, mockIdempotencyStore } =
      createService('viewer');

    const outcome = await service.createManual(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockStore.readActiveRole).toHaveBeenCalled();
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
    expect(mockStore.createManualExchangeRate).not.toHaveBeenCalled();
  });

  it('checks active role first and refuses with FORBIDDEN if caller has no role in workspace', async () => {
    const { service, mockIdempotencyStore } = createService(null);

    const outcome = await service.createManual(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.FORBIDDEN);
    expect(mockIdempotencyStore.read).not.toHaveBeenCalled();
  });

  it('replays response when idempotency key exists with matching fingerprint', async () => {
    const { service, mockStore } = createService('owner', {
      // Derive the fingerprint from COMMAND rather than pasting a literal hash.
      // The literal previously here did not match, so the service correctly took
      // the conflict path and this test never exercised replay at all.
      requestFingerprint: computeRequestFingerprint(COMMAND),
      responseStatus: 201,
      responseEtag: null,
      responseBody: EXCHANGE_RATE,
    });

    const outcome = await service.createManual(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    // Demand REPLAYED outright. Accepting IDEMPOTENCY_CONFLICT as an alternative
    // would keep this test green even if replay were deleted and every repeat call
    // answered with a conflict, which is the opposite of the behaviour it names.
    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.REPLAYED);
    const replayed = outcome as ExchangeRateCreateReplayed;
    expect(replayed.status).toBe(201);
    expect(replayed.body).toEqual(EXCHANGE_RATE);
    expect(mockStore.createManualExchangeRate).not.toHaveBeenCalled();
  });

  it('returns IDEMPOTENCY_CONFLICT when idempotency key exists with mismatched fingerprint', async () => {
    const { service, mockStore } = createService('owner', {
      requestFingerprint: 'completely-different-fingerprint',
      responseStatus: 201,
      responseEtag: null,
      responseBody: EXCHANGE_RATE,
    });

    const outcome = await service.createManual(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(
      EXCHANGE_RATE_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT,
    );
    expect(mockStore.createManualExchangeRate).not.toHaveBeenCalled();
  });

  it('returns ALREADY_RECORDED when rate for pair and effective timestamp already exists', async () => {
    const { service, mockStore } = createService(
      'owner',
      undefined,
      new ExchangeRateAlreadyRecordedError(),
    );

    const outcome = await service.createManual(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.ALREADY_RECORDED);
    expect(mockStore.createManualExchangeRate).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      SUBJECT,
      COMMAND,
    );
  });

  it('creates manual exchange rate successfully and records idempotency with null etag', async () => {
    const { service, mockStore, mockIdempotencyStore } = createService('owner');

    const outcome = await service.createManual(
      SUBJECT,
      WORKSPACE_ID,
      COMMAND,
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe(EXCHANGE_RATE_CREATE_OUTCOMES.CREATED);
    expect((outcome as ExchangeRateCreateCreated).exchangeRate).toEqual(
      EXCHANGE_RATE,
    );
    expect(mockStore.createManualExchangeRate).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      SUBJECT,
      COMMAND,
    );
    expect(mockIdempotencyStore.write).toHaveBeenCalledWith(
      expect.anything(),
      SUBJECT,
      'POST /v1/exchange-rates',
      IDEMPOTENCY_KEY,
      expect.any(String),
      201,
      null, // NO ETag header
      EXCHANGE_RATE,
      WORKSPACE_ID,
    );
  });
});
