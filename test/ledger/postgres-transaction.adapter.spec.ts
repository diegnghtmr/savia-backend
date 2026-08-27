import { describe, expect, it, vi } from 'vitest';

import {
  negateAmountMinor,
  toIso,
  PostgresTransactionAdapter,
} from '../../src/ledger/postgres-transaction.adapter.js';
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

describe('PostgresTransactionAdapter.lockAndReadAccount', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const accountId = '00000000-0000-0000-0000-000000000A01'; // Mixed case to test lowercasing

  it('takes per-account advisory lock on lowercased account id and returns account status', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // 1. Lock
        .mockResolvedValueOnce({ rows: [{ status: 'active' }] }), // 2. Account check
    };

    const result = await adapter.lockAndReadAccount(
      client,
      workspaceId,
      accountId,
    );

    expect(client.query).toHaveBeenCalledTimes(2);
    const [lockSql, lockValues] = (client.query as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, unknown[]];
    expect(lockSql).toContain(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    );
    expect(lockValues).toEqual([accountId.toLowerCase()]);

    const [accountSql, accountValues] = (
      client.query as ReturnType<typeof vi.fn>
    ).mock.calls[1] as [string, unknown[]];
    expect(accountSql).toContain('select a.status from public.accounts a');
    expect(accountValues).toEqual([workspaceId, accountId]);

    expect(result).toEqual({ status: 'active' });
  });

  it('returns undefined when account row does not exist in workspace', async () => {
    const client: TransactionClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // Lock
        .mockResolvedValueOnce({ rows: [] }), // Account check -> empty
    };

    const result = await adapter.lockAndReadAccount(
      client,
      workspaceId,
      accountId,
    );

    expect(result).toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe('PostgresTransactionAdapter.createTransaction', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const subject = '00000000-0000-0000-0000-000000000901';
  const accountId = '00000000-0000-0000-0000-000000000A01';

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

  it('inserts transaction with exact columns, balanced postings, and enforces deferred constraints before returning', async () => {
    const occurredAtDate = new Date('2026-08-20T10:00:00.000Z');
    const createdAtDate = new Date('2026-08-20T10:00:00.000Z');
    const updatedAtDate = new Date('2026-08-20T10:00:00.000Z');

    const client: TransactionClient = {
      query: vi
        .fn()
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
        }) // 1. Insert txn
        .mockResolvedValueOnce({ rows: [] }) // 2. Insert postings
        .mockResolvedValueOnce({ rows: [] }) // 3. Enforce deferred constraints DO $$
        .mockResolvedValueOnce({ rows: [{ code: null }] }), // 4. select nullif(...)
    };

    const result = await adapter.createTransaction(
      client,
      workspaceId,
      subject,
      command,
    );

    expect(client.query).toHaveBeenCalledTimes(4);

    // 1. Pin transactions INSERT SQL and values
    const [txnSql, txnValues] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];
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

    // 2. Pin ledger_postings INSERT SQL and values
    const [postingsSql, postingsValues] = (
      client.query as ReturnType<typeof vi.fn>
    ).mock.calls[1] as [string, unknown[]];
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

    // 3. Pin deferred constraint enforcement SQL after postings insert
    const [constraintDoSql] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[2] as [string];
    expect(constraintDoSql).toContain('set constraints all immediate');
    const [constraintCheckSql] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[3] as [string];
    expect(constraintCheckSql).toContain('current_setting');

    expect(result).toEqual({
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

describe('PostgresTransactionAdapter.readTransaction', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const transactionId = '00000000-0000-0000-0000-000000000t01';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('issues SQL with row-visibility WHERE clause binding both workspace_id and id, takes no advisory lock, and maps row to domain Transaction', async () => {
    const occurredAtDate = new Date('2026-08-20T10:00:00.000Z');
    const createdAtDate = new Date('2026-08-20T10:00:00.000Z');
    const updatedAtDate = new Date('2026-08-20T10:00:00.000Z');

    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: transactionId,
            accountId,
            type: 'expense',
            status: 'confirmed',
            amountMinor: '5000',
            currency: 'USD',
            occurredAt: occurredAtDate,
            description: 'Office Supplies',
            notes: 'Notebooks',
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
      }),
    };

    const result = await adapter.readTransaction(
      client,
      workspaceId,
      transactionId,
    );

    // Assert client.query was called EXACTLY ONCE (proving no advisory lock was taken)
    expect(client.query).toHaveBeenCalledTimes(1);

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];

    // Assert row-visibility predicate in WHERE clause
    expect(sql).toContain('select');
    expect(sql).toContain('from public.transactions');
    expect(sql).toContain('workspace_id = $1::uuid');
    expect(sql).toContain('id = $2::uuid');
    expect(sql).not.toContain('pg_advisory_xact_lock');
    expect(values).toEqual([workspaceId, transactionId]);

    expect(result).toEqual({
      id: transactionId,
      accountId,
      type: 'expense',
      status: 'confirmed',
      amount: {
        amountMinor: '5000',
        currency: 'USD',
      },
      occurredAt: '2026-08-20T10:00:00.000Z',
      description: 'Office Supplies',
      notes: 'Notebooks',
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

  it('returns undefined when client.query returns no rows (transaction not found or belongs to another workspace)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await adapter.readTransaction(
      client,
      workspaceId,
      transactionId,
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });
});
