import { describe, expect, it, vi } from 'vitest';

import type { TransactionClient } from '../../src/identity/pg-transaction.js';
import {
  IDEMPOTENCY_OUTCOME_KINDS,
  type IdempotencyRecord,
  type IdempotencyRequest,
  type IdempotencyStore,
  type StoredResponse,
} from '../../src/identity/idempotency.port.js';
import {
  computeRequestFingerprint,
  IdempotencyService,
  type IdempotencyTransaction,
} from '../../src/identity/idempotency.service.js';

const subject = '00000000-0000-0000-0000-000000000001';
const route = 'POST /v1/workspaces';
const idempotencyKey = 'key-uuid-1';

function createMockClient(): TransactionClient {
  return {
    query: vi.fn(),
  };
}

function createMockTransaction(): IdempotencyTransaction {
  const client = createMockClient();
  return {
    run: vi.fn(async (_, callback) => callback(client)),
  };
}

function createMockStore(
  overrides: Partial<IdempotencyStore> = {},
): IdempotencyStore {
  return {
    read: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('computeRequestFingerprint', () => {
  it('is field-order independent', () => {
    const payloadA = { name: 'Acme', baseCurrency: 'USD', kind: 'shared' };
    const payloadB = { kind: 'shared', name: 'Acme', baseCurrency: 'USD' };
    const payloadC = { baseCurrency: 'USD', kind: 'shared', name: 'Acme' };

    const fpA = computeRequestFingerprint(payloadA);
    const fpB = computeRequestFingerprint(payloadB);
    const fpC = computeRequestFingerprint(payloadC);

    expect(fpA).toBe(fpB);
    expect(fpB).toBe(fpC);
    expect(fpA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles nested objects in a field-order independent manner', () => {
    const nestedA = { outer: { b: 2, a: 1 }, items: [1, { y: 'b', x: 'a' }] };
    const nestedB = { items: [1, { x: 'a', y: 'b' }], outer: { a: 1, b: 2 } };

    expect(computeRequestFingerprint(nestedA)).toBe(
      computeRequestFingerprint(nestedB),
    );
  });

  it('a different workspaceId yields a different fingerprint', () => {
    const payload1 = {
      workspaceId: '00000000-0000-0000-0000-000000000001',
      name: 'Workspace 1',
    };
    const payload2 = {
      workspaceId: '00000000-0000-0000-0000-000000000002',
      name: 'Workspace 1',
    };

    const fp1 = computeRequestFingerprint(payload1);
    const fp2 = computeRequestFingerprint(payload2);

    expect(fp1).not.toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp2).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('IdempotencyService', () => {
  it('executes operation when no live record exists and saves result', async () => {
    const transaction = createMockTransaction();
    const store = createMockStore();
    const service = new IdempotencyService(transaction, store);

    const payload = { name: 'Acme' };
    const request: IdempotencyRequest = {
      subject,
      route,
      idempotencyKey,
      payload,
    };

    const expectedResponse: StoredResponse = {
      status: 201,
      etag: '"v1"',
      body: { id: 'ws-123', name: 'Acme' },
    };

    const operation = vi.fn().mockResolvedValue(expectedResponse);

    const outcome = await service.execute(request, operation);

    expect(outcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: expectedResponse,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledWith(
      expect.anything(),
      subject,
      route,
      idempotencyKey,
      null,
    );
    expect(store.write).toHaveBeenCalledWith(
      expect.anything(),
      subject,
      route,
      idempotencyKey,
      computeRequestFingerprint(payload),
      201,
      '"v1"',
      { id: 'ws-123', name: 'Acme' },
      null,
    );
  });

  it('passes explicit workspaceId to store read and write when provided', async () => {
    const transaction = createMockTransaction();
    const store = createMockStore();
    const service = new IdempotencyService(transaction, store);

    const wsId = '00000000-0000-0000-0000-000000000001';
    const payload = { name: 'Acme' };
    const request: IdempotencyRequest = {
      subject,
      route,
      idempotencyKey,
      workspaceId: wsId,
      payload,
    };

    const expectedResponse: StoredResponse = {
      status: 201,
      etag: '"v1"',
      body: { id: 'acc-1' },
    };

    const operation = vi.fn().mockResolvedValue(expectedResponse);

    const outcome = await service.execute(request, operation);

    expect(outcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.EXECUTED,
      response: expectedResponse,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledWith(
      expect.anything(),
      subject,
      route,
      idempotencyKey,
      wsId,
    );
    expect(store.write).toHaveBeenCalledWith(
      expect.anything(),
      subject,
      route,
      idempotencyKey,
      computeRequestFingerprint(payload),
      201,
      '"v1"',
      { id: 'acc-1' },
      wsId,
    );
  });

  it('replays stored response without executing operation when live record matches fingerprint', async () => {
    const payload = { name: 'Acme' };
    const fingerprint = computeRequestFingerprint(payload);

    const existingRecord: IdempotencyRecord = {
      requestFingerprint: fingerprint,
      responseStatus: 201,
      responseEtag: '"v1"',
      responseBody: { id: 'ws-123', name: 'Acme' },
    };

    const transaction = createMockTransaction();
    const store = createMockStore({
      read: vi.fn().mockResolvedValue(existingRecord),
    });
    const service = new IdempotencyService(transaction, store);

    const request: IdempotencyRequest = {
      subject,
      route,
      idempotencyKey,
      payload,
    };

    const operation = vi.fn();

    const outcome = await service.execute(request, operation);

    expect(outcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.REPLAYED,
      response: {
        status: 201,
        etag: '"v1"',
        body: { id: 'ws-123', name: 'Acme' },
      },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('answers conflict when live record has a different fingerprint under the same key', async () => {
    const firstPayload = { name: 'Acme Original' };
    const originalFingerprint = computeRequestFingerprint(firstPayload);

    const existingRecord: IdempotencyRecord = {
      requestFingerprint: originalFingerprint,
      responseStatus: 201,
      responseEtag: '"v1"',
      responseBody: { id: 'ws-123', name: 'Acme Original' },
    };

    const transaction = createMockTransaction();
    const store = createMockStore({
      read: vi.fn().mockResolvedValue(existingRecord),
    });
    const service = new IdempotencyService(transaction, store);

    const differentPayload = { name: 'Acme Mutated' };
    const request: IdempotencyRequest = {
      subject,
      route,
      idempotencyKey,
      payload: differentPayload,
    };

    const operation = vi.fn();

    const outcome = await service.execute(request, operation);

    expect(outcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.CONFLICT,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('service maps a losing write to a re-read and replay (adapter mocked; the database behaviour is covered in command-idempotency.integration-spec.ts)', async () => {
    const payload = { name: 'Acme' };
    const fingerprint = computeRequestFingerprint(payload);

    const liveRecord: IdempotencyRecord = {
      requestFingerprint: fingerprint,
      responseStatus: 201,
      responseEtag: '"v1"',
      responseBody: { id: 'ws-123', name: 'Acme' },
    };

    const transaction = createMockTransaction();
    // First read returns undefined (missed), write returns false (0 rows), re-read returns liveRecord
    const readMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(liveRecord);
    const writeMock = vi.fn().mockResolvedValue(false);

    const store = createMockStore({
      read: readMock,
      write: writeMock,
    });
    const service = new IdempotencyService(transaction, store);

    const request: IdempotencyRequest = {
      subject,
      route,
      idempotencyKey,
      payload,
    };

    const operation = vi.fn().mockResolvedValue({
      status: 201,
      etag: '"v1"',
      body: { id: 'ws-123', name: 'Acme' },
    });

    const outcome = await service.execute(request, operation);

    expect(outcome).toEqual({
      kind: IDEMPOTENCY_OUTCOME_KINDS.REPLAYED,
      response: {
        status: 201,
        etag: '"v1"',
        body: { id: 'ws-123', name: 'Acme' },
      },
    });
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('evaluates 24-hour boundary: live within 24h triggers replay, expired triggers fresh execution', async () => {
    const now = new Date('2026-08-21T12:00:00.000Z');
    const withinWindow = new Date(now.getTime() - 23 * 3600 * 1000); // 23h ago (live)
    const beyondWindow = new Date(now.getTime() - 25 * 3600 * 1000); // 25h ago (expired)

    const payload = { name: 'Acme' };
    const fingerprint = computeRequestFingerprint(payload);

    // Mock store with timestamp awareness to simulate read query predicate
    const simulateStoreRead = (
      createdAt: Date,
    ): IdempotencyRecord | undefined => {
      const isLive = now.getTime() - createdAt.getTime() < 24 * 3600 * 1000;
      if (!isLive) return undefined;
      return {
        requestFingerprint: fingerprint,
        responseStatus: 200,
        responseEtag: null,
        responseBody: { ok: true },
      };
    };

    // Within window -> live -> replay
    const liveTransaction = createMockTransaction();
    const liveStore = createMockStore({
      read: vi.fn().mockResolvedValue(simulateStoreRead(withinWindow)),
    });
    const liveService = new IdempotencyService(liveTransaction, liveStore);
    const liveOp = vi.fn();
    const liveOutcome = await liveService.execute(
      { subject, route, idempotencyKey, payload },
      liveOp,
    );
    expect(liveOutcome.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.REPLAYED);
    expect(liveOp).not.toHaveBeenCalled();

    // Beyond window -> expired -> store returns undefined -> execute fresh
    const expiredTransaction = createMockTransaction();
    const expiredStore = createMockStore({
      read: vi.fn().mockResolvedValue(simulateStoreRead(beyondWindow)),
    });
    const expiredService = new IdempotencyService(
      expiredTransaction,
      expiredStore,
    );
    const expiredOp = vi.fn().mockResolvedValue({
      status: 201,
      etag: null,
      body: { ok: true },
    });
    const expiredOutcome = await expiredService.execute(
      { subject, route, idempotencyKey, payload },
      expiredOp,
    );
    expect(expiredOutcome.kind).toBe(IDEMPOTENCY_OUTCOME_KINDS.EXECUTED);
    expect(expiredOp).toHaveBeenCalledTimes(1);
  });
});
