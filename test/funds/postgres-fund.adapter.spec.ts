import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresFundAdapter } from '../../src/funds/postgres-fund.adapter.js';

describe('PostgresFundAdapter', () => {
  it('readActiveRole calls public.workspace_actor_active_role', async () => {
    const mockClient = {
      query: vi.fn(async () => ({ rows: [{ role: 'owner' }] })),
    } as unknown as TransactionClient;

    const adapter = new PostgresFundAdapter();
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
        .mockResolvedValueOnce({ rows: [] }) // lock
        .mockResolvedValueOnce({
          rows: [{ status: 'active', currency: 'USD' }],
        }), // query
    } as unknown as TransactionClient;

    const adapter = new PostgresFundAdapter();
    const account = await adapter.lockAndReadAccount(mockClient, 'ws1', 'acc1');
    expect(account).toEqual({ status: 'active', currency: 'USD' });
  });

  it('createFund inserts fund and returns mapped fund', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'f1',
            workspaceId: 'ws1',
            name: 'Emergency Fund',
            currency: 'USD',
            targetAmountMinor: '100000',
            targetDate: '2026-12-31',
            linkedAccountId: null,
            status: 'active',
            version: 1,
            createdAt: new Date('2026-09-03T12:00:00Z'),
            updatedAt: new Date('2026-09-03T12:00:00Z'),
          },
        ],
      })),
    } as unknown as TransactionClient;

    const adapter = new PostgresFundAdapter();
    const fund = await adapter.createFund(mockClient, 'ws1', {
      name: 'Emergency Fund',
      currency: 'USD',
      targetAmount: { amountMinor: '100000', currency: 'USD' },
      targetDate: '2026-12-31',
      linkedAccountId: null,
    });

    expect(fund.id).toBe('f1');
    expect(fund.currentAmount).toEqual({ amountMinor: '0', currency: 'USD' });
    expect(fund.targetAmount).toEqual({
      amountMinor: '100000',
      currency: 'USD',
    });
  });

  it('findFund queries fund and its derived currentAmount', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'f1',
            workspaceId: 'ws1',
            name: 'Emergency Fund',
            currency: 'USD',
            targetAmountMinor: '100000',
            targetDate: '2026-12-31',
            linkedAccountId: null,
            status: 'active',
            version: 1,
            createdAt: new Date('2026-09-03T12:00:00Z'),
            updatedAt: new Date('2026-09-03T12:00:00Z'),
            currentAmountMinor: '25000',
          },
        ],
      })),
    } as unknown as TransactionClient;

    const adapter = new PostgresFundAdapter();
    const fund = await adapter.findFund(mockClient, 'ws1', 'f1');
    expect(fund).toBeDefined();
    expect(fund?.currentAmount).toEqual({
      amountMinor: '25000',
      currency: 'USD',
    });
    expect(fund?.recommendedMonthlyContribution).toBeDefined();
  });

  it('contributeToFund inserts transaction, balanced postings, link row, and enforces deferred constraints', async () => {
    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'txn1',
              accountId: 'acc1',
              type: 'fund_contribution',
              status: 'confirmed',
              amountMinor: '5000',
              currency: 'USD',
              occurredAt: new Date('2026-09-03T12:00:00Z'),
              description: null,
              notes: 'test note',
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
        .mockResolvedValueOnce({ rows: [] }) // link insert
        .mockResolvedValueOnce({ rows: [] }) // set constraints all immediate
        .mockResolvedValueOnce({ rows: [{ code: null }] }), // check code
    } as unknown as TransactionClient;

    const adapter = new PostgresFundAdapter();
    const result = await adapter.contributeToFund(
      mockClient,
      'ws1',
      'sub1',
      {
        id: 'f1',
        name: 'Emergency Fund',
        currency: 'USD',
        targetAmount: { amountMinor: '100000', currency: 'USD' },
        currentAmount: { amountMinor: '0', currency: 'USD' },
        status: 'active',
        version: 1,
        createdAt: '2026-09-03T12:00:00Z',
        updatedAt: '2026-09-03T12:00:00Z',
      },
      {
        accountId: 'acc1',
        amount: { amountMinor: '5000', currency: 'USD' },
        occurredAt: '2026-09-03T12:00:00Z',
        notes: 'test note',
      },
    );

    expect(result.id).toBe('txn1');
    expect(result.type).toBe('fund_contribution');
    expect(result.status).toBe('confirmed');
    expect(mockClient.query).toHaveBeenCalledTimes(5);
  });
});
