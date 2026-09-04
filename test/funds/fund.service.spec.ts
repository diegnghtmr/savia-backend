import { describe, expect, it, vi } from 'vitest';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  FUND_OUTCOMES,
  type CreateFundContributionRequest,
  type CreateFundRequest,
  type Fund,
  type FundStore,
  type FundTransaction,
} from '../../src/funds/fund.port.js';
import {
  FundService,
  type FundTransactionRunner,
} from '../../src/funds/fund.service.js';

describe('FundService', () => {
  const mockClient = {} as TransactionClient;
  const mockTx: FundTransactionRunner = {
    run: vi.fn(async (_subject, callback) => callback(mockClient)),
  };

  const dummyFund: Fund = {
    id: 'f0000000-0000-4000-8000-000000000001',
    name: 'Emergency Fund',
    currency: 'USD',
    targetAmount: { amountMinor: '100000', currency: 'USD' },
    currentAmount: { amountMinor: '0', currency: 'USD' },
    targetDate: '2026-12-31',
    linkedAccountId: null,
    status: 'active',
    version: 1,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
  };

  const dummyTransaction: FundTransaction = {
    id: 't0000000-0000-4000-8000-000000000001',
    type: 'fund_contribution',
    status: 'confirmed',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    amount: { amountMinor: '5000', currency: 'USD' },
    occurredAt: '2026-09-03T12:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: 'test notes',
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    version: 1,
  };

  function createMockStore(): FundStore {
    return {
      readActiveRole: vi.fn(async () => 'owner'),
      createFund: vi.fn(async () => dummyFund),
      findFund: vi.fn(async () => dummyFund),
      listFunds: vi.fn(async () => [{ fund: dummyFund, cursorAt: 'cursor1' }]),
      lockAndReadAccount: vi.fn(async () => ({
        status: 'active',
        currency: 'USD',
      })),
      contributeToFund: vi.fn(async () => dummyTransaction),
    };
  }

  function createMockIdempotency(): IdempotencyStore {
    return {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => true),
    } as unknown as IdempotencyStore;
  }

  describe('createFund', () => {
    const command: CreateFundRequest = {
      name: 'Emergency Fund',
      currency: 'USD',
      targetAmount: { amountMinor: '100000', currency: 'USD' },
    };

    it('returns FORBIDDEN if user is viewer or not member', async () => {
      const store = createMockStore();
      vi.mocked(store.readActiveRole).mockResolvedValue('viewer');
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.createFund('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(FUND_OUTCOMES.FORBIDDEN);
    });

    it('returns REPLAYED when idempotency record exists with same fingerprint', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: computeRequestFingerprint(command),
        responseStatus: 201,
        responseEtag: null,
        responseBody: dummyFund,
      } as never);
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.createFund('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(FUND_OUTCOMES.REPLAYED);
      if (result.kind === FUND_OUTCOMES.REPLAYED) {
        expect(result.status).toBe(201);
        expect(result.etag).toBeNull();
        expect(result.body).toEqual(dummyFund);
      }
      expect(store.createFund).not.toHaveBeenCalled();
      expect(store.lockAndReadAccount).not.toHaveBeenCalled();
      expect(store.findFund).not.toHaveBeenCalled();
      expect(store.listFunds).not.toHaveBeenCalled();
      expect(store.contributeToFund).not.toHaveBeenCalled();
      expect(idempotency.write).not.toHaveBeenCalled();
    });

    it('returns LINKED_ACCOUNT_NOT_FOUND when linkedAccountId does not exist in workspace', async () => {
      const store = createMockStore();
      vi.mocked(store.lockAndReadAccount).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.createFund(
        'sub1',
        'ws1',
        { ...command, linkedAccountId: 'a0000000-0000-4000-8000-000000000001' },
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.LINKED_ACCOUNT_NOT_FOUND);
    });

    it('creates fund and returns CREATED', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.createFund('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(FUND_OUTCOMES.CREATED);
      if (result.kind === FUND_OUTCOMES.CREATED) {
        expect(result.fund.id).toBe(dummyFund.id);
      }
    });

    it('rolls back via FundCreateRollbackError when idempotency write fails and reread has conflict', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      vi.mocked(idempotency.write).mockResolvedValue(false);
      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined) // first read before write
        .mockResolvedValueOnce({
          requestFingerprint: 'different-fingerprint',
          responseStatus: 201,
          responseEtag: null,
          responseBody: dummyFund,
        } as never);

      const service = new FundService(mockTx, store, idempotency);
      const result = await service.createFund('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(FUND_OUTCOMES.CONFLICT);
    });
  });

  describe('listFunds', () => {
    it('returns FORBIDDEN for non-members', async () => {
      const store = createMockStore();
      vi.mocked(store.readActiveRole).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.listFunds('sub1', {
        workspaceId: 'ws1',
        limit: 20,
      });
      expect(result.kind).toBe(FUND_OUTCOMES.FORBIDDEN);
    });

    it('returns ok with page of funds', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.listFunds('sub1', {
        workspaceId: 'ws1',
        limit: 20,
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.page.items).toHaveLength(1);
        expect(result.page.items[0].id).toBe(dummyFund.id);
      }
    });
  });

  describe('contributeToFund', () => {
    const contributionCommand: CreateFundContributionRequest = {
      accountId: 'a0000000-0000-4000-8000-000000000001',
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
      notes: 'test notes',
    };

    it('returns FORBIDDEN if role is not allowed', async () => {
      const store = createMockStore();
      vi.mocked(store.readActiveRole).mockResolvedValue('viewer');
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        contributionCommand,
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.FORBIDDEN);
    });

    it('returns NOT_FOUND if fund does not exist in workspace', async () => {
      const store = createMockStore();
      vi.mocked(store.findFund).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        contributionCommand,
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.NOT_FOUND);
    });

    it('returns CURRENCY_MISMATCH if contribution currency differs from fund currency', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        {
          ...contributionCommand,
          amount: { amountMinor: '5000', currency: 'EUR' },
        },
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.CURRENCY_MISMATCH);
    });

    it('returns ACCOUNT_NOT_FOUND if account does not exist', async () => {
      const store = createMockStore();
      vi.mocked(store.lockAndReadAccount).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        contributionCommand,
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.ACCOUNT_NOT_FOUND);
    });

    it('returns ACCOUNT_CLOSED if account is closed', async () => {
      const store = createMockStore();
      vi.mocked(store.lockAndReadAccount).mockResolvedValue({
        status: 'closed',
        currency: 'USD',
      });
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        contributionCommand,
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.ACCOUNT_CLOSED);
    });

    it('records contribution and returns CREATED', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const service = new FundService(mockTx, store, idempotency);

      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        contributionCommand,
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.CREATED);
      if (result.kind === FUND_OUTCOMES.CREATED) {
        expect(result.transaction.id).toBe(dummyTransaction.id);
      }
    });

    it('rolls back via FundContributionRollbackError when idempotency write fails and reread has conflict', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      vi.mocked(idempotency.write).mockResolvedValue(false);
      vi.mocked(idempotency.read)
        .mockResolvedValueOnce(undefined) // first read
        .mockResolvedValueOnce({
          requestFingerprint: 'different-fingerprint',
          responseStatus: 201,
          responseEtag: null,
          responseBody: dummyTransaction,
        } as never);

      const service = new FundService(mockTx, store, idempotency);
      const result = await service.contributeToFund(
        'sub1',
        'ws1',
        dummyFund.id,
        contributionCommand,
        'key1',
      );
      expect(result.kind).toBe(FUND_OUTCOMES.CONFLICT);
    });
  });
});
