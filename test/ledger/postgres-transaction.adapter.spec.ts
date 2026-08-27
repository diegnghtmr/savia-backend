import { describe, expect, it, vi } from 'vitest';

import {
  negateAmountMinor,
  toIso,
  PostgresTransactionAdapter,
} from '../../src/ledger/postgres-transaction.adapter.js';
import {
  LEDGER_STORE_CREATE_RESULTS,
  type LedgerStoreCreateCreated,
} from '../../src/ledger/transaction.service.js';
import type { CreateTransactionCommand } from '../../src/ledger/ledger.port.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('negateAmountMinor', () => {
  it('negates positive amountMinor without number conversion', () => {
    expect(negateAmountMinor('10000')).toBe('-10000');
    expect(negateAmountMinor('9007199254740993')).toBe('-9007199254740993');
  });

  it('negates negative amountMinor without number conversion', () => {
    expect(negateAmountMinor('-10000')).toBe('10000');
    expect(negateAmountMinor('-9007199254740993')).toBe('9007199254740993');
  });

  it('handles zero without producing negative zero', () => {
    expect(negateAmountMinor('0')).toBe('0');
    expect(negateAmountMinor('-0')).toBe('0');
  });

  it('refuses to negate int64-min rather than minting an out-of-range counter-leg', () => {
    expect(() => negateAmountMinor('-9223372036854775808')).toThrow(RangeError);
    expect(negateAmountMinor('-9223372036854775807')).toBe(
      '9223372036854775807',
    );
  });
});

describe('toIso', () => {
  it('formats a Date to an ISO string', () => {
    const date = new Date('2026-08-20T12:34:56.789Z');
    expect(toIso(date)).toBe('2026-08-20T12:34:56.789Z');
  });

  it('fails loudly when passed a string instead of a Date', () => {
    expect(() => toIso('2026-08-20 12:34:56+00')).toThrow(TypeError);
  });

  it('fails loudly when passed null or undefined', () => {
    expect(() => toIso(null as unknown as Date)).toThrow(TypeError);
    expect(() => toIso(undefined as unknown as Date)).toThrow(TypeError);
  });
});

describe('PostgresTransactionAdapter.readActiveRole', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';

  it('queries workspace_actor_active_role and returns role string', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ role: 'owner' }],
      }),
    };

    const role = await adapter.readActiveRole(client, workspaceId);

    expect(client.query).toHaveBeenCalledWith(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    expect(role).toBe('owner');
  });

  it('returns undefined when workspace_actor_active_role returns null', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ role: null }],
      }),
    };

    const role = await adapter.readActiveRole(client, workspaceId);
    expect(role).toBeUndefined();
  });
});

describe('PostgresTransactionAdapter.createTransaction', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const accountId = '00000000-0000-0000-0000-000000000A01'; // Mixed case to test lowercasing

  const command: CreateTransactionCommand = {
    type: 'expense',
    accountId,
    amount: {
      amountMinor: '12500',
      currency: 'USD',
    },
    occurredAt: '2026-08-20T10:00:00.000Z',
    status: 'confirmed',
    description: 'Hardware purchase',
    notes: 'Laptop accessories',
    categoryId: '00000000-0000-0000-0000-000000000c01',
    payeeId: '00000000-0000-0000-0000-000000000p01',
    receiptId: '00000000-0000-0000-0000-000000000r01',
    tagIds: ['00000000-0000-0000-0000-000000000t01'],
  };

  it('takes per-account advisory lock as first query on lowercased account id', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // Lock
        .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // Account check
        .mockResolvedValueOnce({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000000999',
              accountId,
              type: 'expense',
              status: 'confirmed',
              amountMinor: '12500',
              currency: 'USD',
              occurredAt: new Date('2026-08-20T10:00:00.000Z'),
              description: 'Hardware purchase',
              notes: 'Laptop accessories',
              categoryId: '00000000-0000-0000-0000-000000000c01',
              payeeId: '00000000-0000-0000-0000-000000000p01',
              receiptId: '00000000-0000-0000-0000-000000000r01',
              reconciliationId: null,
              tagIds: ['00000000-0000-0000-0000-000000000t01'],
              createdAt: new Date('2026-08-20T10:00:00.000Z'),
              updatedAt: new Date('2026-08-20T10:00:00.000Z'),
              version: 1,
            },
          ],
        }) // Insert txn
        .mockResolvedValueOnce({ rows: [] }), // Insert postings
    };

    await adapter.createTransaction(client, workspaceId, subject, command);

    expect(client.query).toHaveBeenCalledTimes(4);
    const [lockSql, lockValues] = (client.query as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, unknown[]];
    expect(lockSql).toContain(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    );
    expect(lockValues).toEqual([accountId.toLowerCase()]);
  });

  it('returns ACCOUNT_UNRESOLVED when account row does not exist in workspace', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // Lock
        .mockResolvedValueOnce({ rows: [] }), // Account check -> empty
    };

    const result = await adapter.createTransaction(
      client,
      workspaceId,
      subject,
      command,
    );

    expect(result).toEqual({
      kind: LEDGER_STORE_CREATE_RESULTS.ACCOUNT_UNRESOLVED,
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('returns ACCOUNT_CLOSED when account status is closed', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // Lock
        .mockResolvedValueOnce({ rows: [{ status: 'closed' }] }), // Account check -> closed
    };

    const result = await adapter.createTransaction(
      client,
      workspaceId,
      subject,
      command,
    );

    expect(result).toEqual({
      kind: LEDGER_STORE_CREATE_RESULTS.ACCOUNT_CLOSED,
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('inserts transaction with exact columns and balanced postings with account leg and external leg', async () => {
    const occurredAtDate = new Date('2026-08-20T10:00:00.000Z');
    const createdAtDate = new Date('2026-08-20T10:00:00.000Z');
    const updatedAtDate = new Date('2026-08-20T10:00:00.000Z');

    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // 1. Lock
        .mockResolvedValueOnce({ rows: [{ status: 'active' }] }) // 2. Account check
        .mockResolvedValueOnce({
          rows: [
            {
              id: '00000000-0000-0000-0000-000000000999',
              accountId,
              type: 'expense',
              status: 'confirmed',
              amountMinor: '12500',
              currency: 'USD',
              occurredAt: occurredAtDate,
              description: 'Hardware purchase',
              notes: 'Laptop accessories',
              categoryId: '00000000-0000-0000-0000-000000000c01',
              payeeId: '00000000-0000-0000-0000-000000000p01',
              receiptId: '00000000-0000-0000-0000-000000000r01',
              reconciliationId: null,
              tagIds: ['00000000-0000-0000-0000-000000000t01'],
              createdAt: createdAtDate,
              updatedAt: updatedAtDate,
              version: 1,
            },
          ],
        }) // 3. Insert txn
        .mockResolvedValueOnce({ rows: [] }), // 4. Insert postings
    };

    const result = await adapter.createTransaction(
      client,
      workspaceId,
      subject,
      command,
    );

    expect(client.query).toHaveBeenCalledTimes(4);

    // 3. Pin transactions INSERT SQL and values
    const [txnSql, txnValues] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[2] as [string, unknown[]];
    expect(txnSql).toContain('insert into public.transactions');
    expect(txnSql).toContain('workspace_id');
    expect(txnSql).toContain('account_id');
    expect(txnSql).toContain('type');
    expect(txnSql).toContain('status');
    expect(txnSql).toContain('amount_minor');
    expect(txnSql).toContain('currency');
    expect(txnSql).toContain('occurred_at');
    expect(txnSql).toContain('description');
    expect(txnSql).toContain('notes');
    expect(txnSql).toContain('category_id');
    expect(txnSql).toContain('payee_id');
    expect(txnSql).toContain('receipt_id');
    expect(txnSql).toContain('tag_ids');
    expect(txnSql).toContain('created_by');
    expect(txnValues).toEqual([
      workspaceId,
      accountId,
      'expense',
      'confirmed',
      '12500',
      'USD',
      '2026-08-20T10:00:00.000Z',
      'Hardware purchase',
      'Laptop accessories',
      '00000000-0000-0000-0000-000000000c01',
      '00000000-0000-0000-0000-000000000p01',
      '00000000-0000-0000-0000-000000000r01',
      ['00000000-0000-0000-0000-000000000t01'],
      subject,
    ]);

    // 4. Pin ledger_postings INSERT SQL and values
    const [postingsSql, postingsValues] = (
      client.query as ReturnType<typeof vi.fn>
    ).mock.calls[3] as [string, unknown[]];
    expect(postingsSql).toContain('insert into public.ledger_postings');
    expect(postingsSql).toContain("'account'");
    expect(postingsSql).toContain("'external'");
    expect(postingsSql).toContain('null'); // External leg carries null account_id
    expect(postingsValues).toEqual([
      workspaceId,
      '00000000-0000-0000-0000-000000000999',
      accountId,
      '12500',
      'USD',
      'confirmed',
      occurredAtDate,
      '-12500', // Negated amount for external leg
    ]);

    expect(result.kind).toBe(LEDGER_STORE_CREATE_RESULTS.CREATED);
    const created = (result as LedgerStoreCreateCreated).transaction;
    expect(created).toEqual({
      id: '00000000-0000-0000-0000-000000000999',
      accountId,
      type: 'expense',
      status: 'confirmed',
      amount: {
        amountMinor: '12500',
        currency: 'USD',
      },
      occurredAt: '2026-08-20T10:00:00.000Z',
      description: 'Hardware purchase',
      notes: 'Laptop accessories',
      categoryId: '00000000-0000-0000-0000-000000000c01',
      payeeId: '00000000-0000-0000-0000-000000000p01',
      receiptId: '00000000-0000-0000-0000-000000000r01',
      reconciliationId: null,
      tagIds: ['00000000-0000-0000-0000-000000000t01'],
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      version: 1,
    });
  });
});
