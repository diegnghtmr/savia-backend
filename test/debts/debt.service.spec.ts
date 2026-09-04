import { describe, expect, it, vi } from 'vitest';
import { computeRequestFingerprint } from '../../src/platform/idempotency.service.js';
import type { IdempotencyStore } from '../../src/platform/idempotency.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  DEBT_OUTCOMES,
  type CreateDebtPaymentRequest,
  type CreateDebtRequest,
  type Debt,
  type DebtStore,
  type DebtTransaction,
} from '../../src/debts/debt.port.js';
import {
  DebtService,
  type DebtTransactionRunner,
} from '../../src/debts/debt.service.js';

describe('DebtService', () => {
  const mockClient = {} as TransactionClient;
  const mockTx: DebtTransactionRunner = {
    run: vi.fn(async (_subject, callback) => callback(mockClient)),
  };

  const dummyDebt: Debt = {
    id: 'd0000000-0000-4000-8000-000000000001',
    name: 'Mortgage Loan',
    currency: 'USD',
    principal: { amountMinor: '25000000', currency: 'USD' },
    outstandingBalance: { amountMinor: '25000000', currency: 'USD' },
    annualRate: '0.045000000000000000',
    rateType: 'fixed',
    status: 'active',
  };

  const dummyTransaction: DebtTransaction = {
    id: 't0000000-0000-4000-8000-000000000001',
    type: 'debt_payment',
    status: 'confirmed',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    amount: { amountMinor: '-5000', currency: 'USD' },
    occurredAt: '2026-09-03T12:00:00.000Z',
    categoryId: null,
    payeeId: null,
    description: null,
    notes: null,
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    version: 1,
  };

  function createMockStore(): DebtStore {
    return {
      readActiveRole: vi.fn(async () => 'owner'),
      createDebt: vi.fn(async () => dummyDebt),
      findDebt: vi.fn(async () => dummyDebt),
      listDebts: vi.fn(async () => [{ debt: dummyDebt, cursorAt: 'cursor1' }]),
      lockAndReadAccount: vi.fn(async () => ({
        status: 'active',
        currency: 'USD',
      })),
      createDebtPayment: vi.fn(async () => dummyTransaction),
    };
  }

  function createMockIdempotency(): IdempotencyStore {
    return {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => true),
    } as unknown as IdempotencyStore;
  }

  describe('createDebt', () => {
    const command: CreateDebtRequest = {
      name: 'Mortgage Loan',
      principal: { amountMinor: '25000000', currency: 'USD' },
      annualRate: '0.045',
      rateType: 'fixed',
    };

    it('returns FORBIDDEN if user is viewer or not member', async () => {
      const store = createMockStore();
      vi.mocked(store.readActiveRole).mockResolvedValue('viewer');
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebt('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(DEBT_OUTCOMES.FORBIDDEN);
    });

    it('returns REPLAYED when idempotency record exists with same fingerprint', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: computeRequestFingerprint(command),
        responseStatus: 201,
        responseEtag: null,
        responseBody: dummyDebt,
      });
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebt('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(DEBT_OUTCOMES.REPLAYED);
    });

    it('returns CONFLICT when idempotency record exists with different fingerprint', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: 'different-fingerprint',
        responseStatus: 201,
        responseEtag: null,
        responseBody: dummyDebt,
      });
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebt('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(DEBT_OUTCOMES.CONFLICT);
    });

    it('creates debt and returns CREATED', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebt('sub1', 'ws1', command, 'key1');
      expect(result.kind).toBe(DEBT_OUTCOMES.CREATED);
      if (result.kind === DEBT_OUTCOMES.CREATED) {
        expect(result.debt).toEqual(dummyDebt);
      }
      expect(store.createDebt).toHaveBeenCalledWith(mockClient, 'ws1', command);
      expect(idempotency.write).toHaveBeenCalled();
    });
  });

  describe('listDebts', () => {
    it('returns FORBIDDEN if user has no role', async () => {
      const store = createMockStore();
      vi.mocked(store.readActiveRole).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.listDebts('sub1', {
        workspaceId: 'ws1',
        limit: 10,
      });
      expect(result.kind).toBe(DEBT_OUTCOMES.FORBIDDEN);
    });

    it('returns page of debts for viewer', async () => {
      const store = createMockStore();
      vi.mocked(store.readActiveRole).mockResolvedValue('viewer');
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.listDebts('sub1', {
        workspaceId: 'ws1',
        limit: 10,
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.page.items).toEqual([dummyDebt]);
      }
    });
  });

  describe('createDebtPayment', () => {
    const paymentCommand: CreateDebtPaymentRequest = {
      accountId: 'a0000000-0000-4000-8000-000000000001',
      totalAmount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-09-03T12:00:00Z',
    };

    it('returns NOT_FOUND when debt does not exist', async () => {
      const store = createMockStore();
      vi.mocked(store.findDebt).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.NOT_FOUND);
    });

    it('returns CURRENCY_MISMATCH when payment currency != debt currency (Guard 1)', async () => {
      const store = createMockStore();
      vi.mocked(store.findDebt).mockResolvedValue({
        ...dummyDebt,
        currency: 'EUR',
      });
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.CURRENCY_MISMATCH);
    });

    it('returns ACCOUNT_NOT_FOUND when account does not exist', async () => {
      const store = createMockStore();
      vi.mocked(store.lockAndReadAccount).mockResolvedValue(undefined);
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.ACCOUNT_NOT_FOUND);
    });

    it('returns ACCOUNT_CLOSED when account is closed', async () => {
      const store = createMockStore();
      vi.mocked(store.lockAndReadAccount).mockResolvedValue({
        status: 'closed',
        currency: 'USD',
      });
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.ACCOUNT_CLOSED);
    });

    it('returns ACCOUNT_CURRENCY_MISMATCH when payment currency != account currency (Guard 2)', async () => {
      const store = createMockStore();
      vi.mocked(store.lockAndReadAccount).mockResolvedValue({
        status: 'active',
        currency: 'EUR', // Account is EUR, payment is USD
      });
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH);
      // Ensure no write was initiated before this check
      expect(store.createDebtPayment).not.toHaveBeenCalled();
    });

    it('creates debt payment and returns CREATED', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.CREATED);
      if (result.kind === DEBT_OUTCOMES.CREATED) {
        expect(result.transaction).toEqual(dummyTransaction);
      }
      expect(store.createDebtPayment).toHaveBeenCalledWith(
        mockClient,
        'ws1',
        'sub1',
        dummyDebt,
        paymentCommand,
      );
    });

    it('returns REPLAYED without calling findDebt or lockAndReadAccount on identical replay', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      const fingerprint = computeRequestFingerprint({
        debtId: 'd1',
        ...paymentCommand,
      });
      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: fingerprint,
        responseStatus: 201,
        responseEtag: '"1"',
        responseBody: dummyTransaction,
      });
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.REPLAYED);
      if (result.kind === DEBT_OUTCOMES.REPLAYED) {
        expect(result.status).toBe(201);
        expect(result.body).toEqual(dummyTransaction);
      }
      expect(store.findDebt).not.toHaveBeenCalled();
      expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    });

    it('returns CONFLICT without calling findDebt or lockAndReadAccount on mismatched replay', async () => {
      const store = createMockStore();
      const idempotency = createMockIdempotency();
      vi.mocked(idempotency.read).mockResolvedValue({
        requestFingerprint: 'different-fingerprint',
        responseStatus: 201,
        responseEtag: '"1"',
        responseBody: dummyTransaction,
      });
      const service = new DebtService(mockTx, store, idempotency);

      const result = await service.createDebtPayment(
        'sub1',
        'ws1',
        'd1',
        paymentCommand,
        'key1',
      );
      expect(result.kind).toBe(DEBT_OUTCOMES.CONFLICT);
      expect(store.findDebt).not.toHaveBeenCalled();
      expect(store.lockAndReadAccount).not.toHaveBeenCalled();
    });
  });
});
