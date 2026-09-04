import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import {
  negateAmountMinor,
  toIso,
  PostgresDebtAdapter,
} from '../../src/debts/postgres-debt.adapter.js';

describe('PostgresDebtAdapter helpers', () => {
  describe('negateAmountMinor', () => {
    it('negates positive amount', () => {
      expect(negateAmountMinor('5000')).toBe('-5000');
    });

    it('negates negative amount to positive', () => {
      expect(negateAmountMinor('-5000')).toBe('5000');
    });

    it('handles zero cleanly', () => {
      expect(negateAmountMinor('0')).toBe('0');
      expect(negateAmountMinor('-0')).toBe('0');
    });

    it('throws RangeError when counter-leg would overflow int8', () => {
      expect(() =>
        negateAmountMinor('-9223372036854775809'),
      ).toThrow(RangeError);
    });
  });

  describe('toIso', () => {
    it('formats Date to ISO string', () => {
      const date = new Date('2026-09-03T12:00:00Z');
      expect(toIso(date)).toBe('2026-09-03T12:00:00.000Z');
    });

    it('returns string as-is', () => {
      expect(toIso('2026-09-03T12:00:00Z')).toBe('2026-09-03T12:00:00Z');
    });

    it('throws TypeError for other types', () => {
      expect(() => toIso(123)).toThrow(TypeError);
    });
  });
});

describe('PostgresDebtAdapter', () => {
  it('readActiveRole calls public.workspace_actor_active_role', async () => {
    const mockClient = {
      query: vi.fn(async () => ({ rows: [{ role: 'owner' }] })),
    } as unknown as TransactionClient;

    const adapter = new PostgresDebtAdapter();
    const role = await adapter.readActiveRole(mockClient, 'ws1');
    expect(role).toBe('owner');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('public.workspace_actor_active_role'),
      ['ws1'],
    );
  });

  it('lockAndReadAccount locks account and returns record', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({
          rows: [{ status: 'active', currency: 'USD' }],
        }), // query
    } as unknown as TransactionClient;

    const adapter = new PostgresDebtAdapter();
    const account = await adapter.lockAndReadAccount(mockClient, 'ws1', 'acc1');
    expect(account).toEqual({ status: 'active', currency: 'USD' });
  });

  it('createDebt inserts debt and returns mapped debt', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'd1',
            workspaceId: 'ws1',
            name: 'Mortgage',
            currency: 'USD',
            principalMinor: '25000000',
            annualRate: '0.045',
            rateType: 'fixed',
            minimumPaymentMinor: '150000',
            startDate: '2026-01-01',
            termMonths: 360,
            nextPaymentAt: null,
            status: 'active',
            version: 1,
            createdAt: new Date('2026-09-03T12:00:00Z'),
            updatedAt: new Date('2026-09-03T12:00:00Z'),
          },
        ],
      })),
    } as unknown as TransactionClient;

    const adapter = new PostgresDebtAdapter();
    const debt = await adapter.createDebt(mockClient, 'ws1', {
      name: 'Mortgage',
      principal: { amountMinor: '25000000', currency: 'USD' },
      annualRate: '0.045',
      rateType: 'fixed',
      minimumPayment: { amountMinor: '150000', currency: 'USD' },
      startDate: '2026-01-01',
      termMonths: 360,
    });

    expect(debt.name).toBe('Mortgage');
    expect(debt.principal).toEqual({ amountMinor: '25000000', currency: 'USD' });
    expect(debt.outstandingBalance).toEqual({
      amountMinor: '25000000',
      currency: 'USD',
    });
    expect(debt.annualRate).toBe('0.045');
    expect(debt.rateType).toBe('fixed');
    expect(debt.minimumPayment).toEqual({
      amountMinor: '150000',
      currency: 'USD',
    });
  });

  it('createDebtPayment creates transaction, balanced postings, split link, and enforces deferred constraints', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'txn1',
              accountId: 'acc1',
              type: 'debt_payment',
              status: 'confirmed',
              amountMinor: '-5000',
              currency: 'USD',
              occurredAt: new Date('2026-09-03T12:00:00Z'),
              description: null,
              notes: null,
              categoryId: null,
              payeeId: null,
              receiptId: null,
              reconciliationId: null,
              tagIds: [],
              createdAt: new Date('2026-09-03T12:00:00Z'),
              updatedAt: new Date('2026-09-03T12:00:00Z'),
              version: 1,
            },
          ],
        }) // txn insert
        .mockResolvedValueOnce({ rows: [] }) // postings insert
        .mockResolvedValueOnce({ rows: [] }) // debt_payments insert
        .mockResolvedValueOnce({ rows: [] }) // set constraints all immediate
        .mockResolvedValueOnce({ rows: [{ code: null }] }), // check code
    } as unknown as TransactionClient;

    const adapter = new PostgresDebtAdapter();
    const result = await adapter.createDebtPayment(
      mockClient,
      'ws1',
      'sub1',
      {
        id: 'd1',
        name: 'Mortgage',
        currency: 'USD',
        principal: { amountMinor: '25000000', currency: 'USD' },
        outstandingBalance: { amountMinor: '25000000', currency: 'USD' },
        annualRate: '0.045',
        rateType: 'fixed',
        status: 'active',
      },
      {
        accountId: 'acc1',
        totalAmount: { amountMinor: '5000', currency: 'USD' },
        principalAmount: { amountMinor: '3000', currency: 'USD' },
        interestAmount: { amountMinor: '1500', currency: 'USD' },
        feeAmount: { amountMinor: '500', currency: 'USD' },
        occurredAt: '2026-09-03T12:00:00Z',
      },
    );

    expect(result.id).toBe('txn1');
    expect(result.type).toBe('debt_payment');
    // Account leg outflow is negative (-5000)
    expect(result.amount).toEqual({ amountMinor: '-5000', currency: 'USD' });

    // Check that postings insert was called with -5000 for account leg and 5000 for counter leg
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('insert into public.ledger_postings'),
      expect.arrayContaining(['ws1', 'txn1', 'acc1', '-5000', 'USD', '5000']),
    );

    // Check that debt_payments insert was called with principal 3000, interest 1500, fee 500
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('insert into public.debt_payments'),
      ['ws1', 'd1', 'txn1', '3000', '1500', '500'],
    );
  });
});
