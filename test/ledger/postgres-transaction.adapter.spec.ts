import { describe, expect, it, vi } from 'vitest';

import {
  negateAmountMinor,
  toIso,
  PostgresTransactionAdapter,
} from '../../src/ledger/postgres-transaction.adapter.js';
import {
  TransactionCategoryNotFoundError,
  TransactionPayeeNotFoundError,
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

  it('throws TransactionCategoryNotFoundError when query fails with 23503 and constraint transactions_category_workspace_fkey', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockRejectedValue({
        code: '23503',
        constraint: 'transactions_category_workspace_fkey',
        message:
          'insert or update on table "transactions" violates foreign key constraint "transactions_category_workspace_fkey"',
      }),
    };

    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000a01',
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
      categoryId: '00000000-0000-0000-0000-000000000c01',
    };

    await expect(
      adapter.createTransaction(client, workspaceId, subject, command),
    ).rejects.toThrow(TransactionCategoryNotFoundError);
  });

  it('throws TransactionPayeeNotFoundError when query fails with 23503 and constraint transactions_payee_workspace_fkey', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockRejectedValue({
        code: '23503',
        constraint: 'transactions_payee_workspace_fkey',
        message:
          'insert or update on table "transactions" violates foreign key constraint "transactions_payee_workspace_fkey"',
      }),
    };

    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000a01',
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
      payeeId: '00000000-0000-0000-0000-000000000p01',
    };

    await expect(
      adapter.createTransaction(client, workspaceId, subject, command),
    ).rejects.toThrow(TransactionPayeeNotFoundError);
  });

  it('re-throws unmapped 23503 errors (e.g. transactions_account_workspace_fkey) untouched', async () => {
    const unrelatedError = {
      code: '23503',
      constraint: 'transactions_account_workspace_fkey',
      message: 'foreign key constraint violation',
    };
    const client: TransactionClient = {
      query: vi.fn().mockRejectedValue(unrelatedError),
    };

    const command: CreateTransactionCommand = {
      type: 'expense',
      accountId: '00000000-0000-0000-0000-000000000a01',
      amount: { amountMinor: '5000', currency: 'USD' },
      occurredAt: '2026-08-20T10:00:00.000Z',
      status: 'confirmed',
    };

    await expect(
      adapter.createTransaction(client, workspaceId, subject, command),
    ).rejects.toMatchObject(unrelatedError);
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

describe('PostgresTransactionAdapter.listTransactions', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const transactionId = '00000000-0000-0000-0000-000000000t01';
  const accountId = '00000000-0000-0000-0000-000000000a01';
  const categoryId = '00000000-0000-0000-0000-000000000c01';

  it('issues keyset SQL with workspace_id predicate, order by occurred_at desc, id asc, and maps rows', async () => {
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
            categoryId,
            payeeId: null,
            receiptId: null,
            reconciliationId: null,
            tagIds: [],
            createdAt: createdAtDate,
            updatedAt: updatedAtDate,
            version: 1,
            cursorAt: '2026-08-20T10:00:00.000000Z',
          },
        ],
      }),
    };

    const result = await adapter.listTransactions(
      client,
      workspaceId,
      undefined,
      50,
      {},
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];

    expect(sql).toContain('select');
    expect(sql).toContain('from public.transactions t');
    expect(sql).toContain('t.workspace_id = $1::uuid');
    expect(sql).toContain('order by t.occurred_at desc, t.id asc');
    expect(sql).toContain('limit $2');
    expect(values).toEqual([workspaceId, 50]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      transaction: {
        id: transactionId,
        accountId,
        type: 'expense',
        status: 'confirmed',
        amount: {
          amountMinor: '5000',
          currency: 'USD',
        },
        occurredAt: '2026-08-20T10:00:00.000Z',
        categoryId,
        payeeId: null,
        description: 'Office Supplies',
        notes: 'Notebooks',
        tagIds: [],
        receiptId: null,
        reconciliationId: null,
        createdAt: '2026-08-20T10:00:00.000Z',
        updatedAt: '2026-08-20T10:00:00.000Z',
        version: 1,
      },
      cursorAt: '2026-08-20T10:00:00.000000Z',
    });
  });

  it('appends keyset predicate when cursor is provided', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listTransactions(
      client,
      workspaceId,
      {
        createdAt: '2026-08-20T10:00:00.123456Z',
        id: transactionId,
      },
      50,
      {},
    );

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];

    expect(sql).toContain(
      '(t.occurred_at < $2::timestamptz or (t.occurred_at = $2::timestamptz and t.id > $3::uuid))',
    );
    expect(values).toEqual([
      workspaceId,
      '2026-08-20T10:00:00.123456Z',
      transactionId,
      50,
    ]);
  });

  it('appends each filter as a bound parameter without interpolating values into SQL text', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await adapter.listTransactions(client, workspaceId, undefined, 50, {
      accountId,
      status: 'confirmed',
      categoryId,
      from: '2026-08-01',
      to: '2026-08-31',
      query: 'Coffee',
    });

    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];

    expect(sql).toContain('t.workspace_id = $1::uuid');
    expect(sql).toContain('t.account_id = $2::uuid');
    expect(sql).toContain('t.status = $3');
    expect(sql).toContain('t.category_id = $4::uuid');
    expect(sql).toContain('t.occurred_at >= $5::timestamptz');
    expect(sql).toContain(
      "t.occurred_at < ($6::timestamptz + interval '1 day')",
    );
    expect(sql).toContain(
      "(t.description ilike ('%' || $7 || '%') or t.notes ilike ('%' || $7 || '%'))",
    );

    // Verify bound parameter array
    expect(values).toEqual([
      workspaceId,
      accountId,
      'confirmed',
      categoryId,
      '2026-08-01',
      '2026-08-31',
      'Coffee',
      50,
    ]);

    // Verify NO filter values are interpolated as literals into the SQL text
    expect(sql).not.toContain("'confirmed'");
    expect(sql).not.toContain("'Coffee'");
    expect(sql).not.toContain("'2026-08-01'");
    expect(sql).not.toContain("'2026-08-31'");
    expect(sql).not.toContain(`'${accountId}'`);
    expect(sql).not.toContain(`'${categoryId}'`);
  });
});

describe('PostgresTransactionAdapter.updateTransaction', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const transactionId = '00000000-0000-0000-0000-000000000t01';
  const accountId = '00000000-0000-0000-0000-000000000a01';

  it('issues atomic conditional UPDATE SQL with version guard, sets updated_at and version bump, takes no advisory lock, and maps row', async () => {
    const occurredAtDate = new Date('2026-08-21T12:00:00.000Z');
    const createdAtDate = new Date('2026-08-20T10:00:00.000Z');
    const updatedAtDate = new Date('2026-08-21T12:00:00.000Z');

    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: transactionId,
            accountId,
            type: 'expense',
            status: 'pending',
            amountMinor: '5000',
            currency: 'USD',
            occurredAt: occurredAtDate,
            description: 'Updated description',
            notes: 'Updated notes',
            categoryId: '00000000-0000-0000-0000-000000000c02',
            payeeId: '00000000-0000-0000-0000-000000000p02',
            receiptId: null,
            reconciliationId: null,
            tagIds: ['00000000-0000-0000-0000-000000000t02'],
            createdAt: createdAtDate,
            updatedAt: updatedAtDate,
            version: 2,
          },
        ],
      }),
    };

    const result = await adapter.updateTransaction(
      client,
      workspaceId,
      transactionId,
      {
        occurredAt: '2026-08-21T12:00:00.000Z',
        categoryId: '00000000-0000-0000-0000-000000000c02',
        payeeId: '00000000-0000-0000-0000-000000000p02',
        description: 'Updated description',
        notes: 'Updated notes',
        tagIds: ['00000000-0000-0000-0000-000000000t02'],
        status: 'pending',
      },
      1,
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, values] = (client.query as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown[]];

    expect(sql).toContain('update public.transactions');
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('occurred_at = $3::timestamptz');
    expect(sql).toContain('category_id = $4::uuid');
    expect(sql).toContain('payee_id = $5::uuid');
    expect(sql).toContain('description = $6');
    expect(sql).toContain('notes = $7');
    expect(sql).toContain('tag_ids = $8::uuid[]');
    expect(sql).toContain('status = $9');
    expect(sql).toContain('where workspace_id = $1::uuid');
    expect(sql).toContain('and id = $2::uuid');
    expect(sql).toContain(
      'and ($10::integer[] is null or version = any($10::integer[]))',
    );
    expect(sql).not.toContain('pg_advisory_xact_lock');
    expect(values).toEqual([
      workspaceId,
      transactionId,
      '2026-08-21T12:00:00.000Z',
      '00000000-0000-0000-0000-000000000c02',
      '00000000-0000-0000-0000-000000000p02',
      'Updated description',
      'Updated notes',
      ['00000000-0000-0000-0000-000000000t02'],
      'pending',
      [1],
    ]);

    expect(result).toEqual({
      id: transactionId,
      accountId,
      type: 'expense',
      status: 'pending',
      amount: {
        amountMinor: '5000',
        currency: 'USD',
      },
      occurredAt: '2026-08-21T12:00:00.000Z',
      description: 'Updated description',
      notes: 'Updated notes',
      categoryId: '00000000-0000-0000-0000-000000000c02',
      payeeId: '00000000-0000-0000-0000-000000000p02',
      receiptId: null,
      reconciliationId: null,
      tagIds: ['00000000-0000-0000-0000-000000000t02'],
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-21T12:00:00.000Z',
      version: 2,
    });
  });

  it('returns undefined when client.query returns no rows (mismatched version, missing row, or forbidden status)', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await adapter.updateTransaction(
      client,
      workspaceId,
      transactionId,
      { description: 'Attempt' },
      1,
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('throws TransactionCategoryNotFoundError when update query fails with 23503 and constraint transactions_category_workspace_fkey', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockRejectedValue({
        code: '23503',
        constraint: 'transactions_category_workspace_fkey',
      }),
    };

    await expect(
      adapter.updateTransaction(client, workspaceId, transactionId, {
        categoryId: '00000000-0000-0000-0000-000000000c02',
      }),
    ).rejects.toThrow(TransactionCategoryNotFoundError);
  });

  it('throws TransactionPayeeNotFoundError when update query fails with 23503 and constraint transactions_payee_workspace_fkey', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockRejectedValue({
        code: '23503',
        constraint: 'transactions_payee_workspace_fkey',
      }),
    };

    await expect(
      adapter.updateTransaction(client, workspaceId, transactionId, {
        payeeId: '00000000-0000-0000-0000-000000000p02',
      }),
    ).rejects.toThrow(TransactionPayeeNotFoundError);
  });

  it('re-throws unmapped 23503 errors on update untouched', async () => {
    const unrelatedError = {
      code: '23503',
      constraint: 'some_other_fkey',
    };
    const client: TransactionClient = {
      query: vi.fn().mockRejectedValue(unrelatedError),
    };

    await expect(
      adapter.updateTransaction(client, workspaceId, transactionId, {
        description: 'Test',
      }),
    ).rejects.toMatchObject(unrelatedError);
  });
});

describe('PostgresTransactionAdapter.voidTransaction', () => {
  const adapter = new PostgresTransactionAdapter();
  const workspaceId = '00000000-0000-0000-0000-000000000951';
  const transactionId = '00000000-0000-0000-0000-000000000701';
  const accountId = '00000000-0000-0000-0000-000000000A01'; // Uppercase to verify lowercase lock

  const sampleRow = {
    id: transactionId,
    accountId: accountId.toLowerCase(),
    type: 'expense',
    status: 'voided',
    amountMinor: 5000n,
    currency: 'USD',
    occurredAt: new Date('2026-08-20T10:00:00.000Z'),
    categoryId: null,
    payeeId: null,
    description: 'Groceries',
    notes: null,
    tagIds: [],
    receiptId: null,
    reconciliationId: null,
    voidedAt: new Date('2026-08-27T19:00:00.000Z'),
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-27T19:00:00.000Z'),
    version: 2,
  };

  it('acquires advisory lock FIRST, flips status, appends reversal postings, and calls enforceDeferredConstraints', async () => {
    const executedQueries: { sql: string; values?: readonly unknown[] }[] = [];

    const client: TransactionClient = {
      query: vi
        .fn()
        .mockImplementation((sql: string, values?: readonly unknown[]) => {
          executedQueries.push({ sql, values });
          if (sql.includes('select pg_advisory_xact_lock')) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('update public.transactions')) {
            return Promise.resolve({ rows: [sampleRow] });
          }
          if (sql.includes('insert into public.ledger_postings')) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('set constraints all immediate')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
    };

    const result = await adapter.voidTransaction(
      client,
      workspaceId,
      transactionId,
      accountId,
      'confirmed',
      1,
    );

    expect(client.query).toHaveBeenCalledTimes(5);

    // 1. Advisory lock query must be first with lowercased accountId
    expect(executedQueries[0]!.sql).toContain(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    );
    expect(executedQueries[0]!.values).toEqual([accountId.toLowerCase()]);

    // 2. Status flip query must set status='voided', voided_at=now(), updated_at=now(), version=version+1
    expect(executedQueries[1]!.sql).toContain("set status = 'voided'");
    expect(executedQueries[1]!.sql).toContain('voided_at = now()');
    expect(executedQueries[1]!.sql).toContain('updated_at = now()');
    expect(executedQueries[1]!.sql).toContain('version = version + 1');
    expect(executedQueries[1]!.sql).toContain(
      "status in ('pending', 'confirmed')",
    );
    expect(executedQueries[1]!.values).toEqual([
      workspaceId,
      transactionId,
      [1],
    ]);

    // 3. Postings insert query must append reversal with negated amount, SAME currency, void instant
    expect(executedQueries[2]!.sql).toContain(
      'insert into public.ledger_postings',
    );
    expect(executedQueries[2]!.values).toEqual([
      workspaceId,
      transactionId,
      accountId.toLowerCase(),
      '-5000', // Negated account leg amount
      'USD', // Same currency
      'confirmed', // Same status
      sampleRow.voidedAt, // Void instant occurred_at
      '5000', // Negated external leg amount (compensates original -5000)
    ]);

    // 4. enforceDeferredConstraints must be called AFTER postings insert
    expect(executedQueries[3]!.sql).toContain('set constraints all immediate');
    expect(executedQueries[4]!.sql).toContain('current_setting');

    // 5. Returned transaction matches shape
    expect(result).toEqual({
      id: transactionId,
      accountId: accountId.toLowerCase(),
      type: 'expense',
      status: 'voided',
      amount: {
        amountMinor: '5000',
        currency: 'USD',
      },
      occurredAt: '2026-08-20T10:00:00.000Z',
      categoryId: null,
      payeeId: null,
      description: 'Groceries',
      notes: null,
      tagIds: [],
      receiptId: null,
      reconciliationId: null,
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-27T19:00:00.000Z',
      version: 2,
    });

    // Verify original postings were never UPDATEd or DELETEd
    for (const q of executedQueries) {
      expect(q.sql.toLowerCase()).not.toContain(
        'delete from public.ledger_postings',
      );
      expect(q.sql.toLowerCase()).not.toContain(
        'update public.ledger_postings',
      );
    }
  });

  it('returns undefined and aborts further writes when update returns no rows', async () => {
    const executedQueries: string[] = [];
    const client: TransactionClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        executedQueries.push(sql);
        if (sql.includes('select pg_advisory_xact_lock')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('update public.transactions')) {
          return Promise.resolve({ rows: [] }); // Zero rows matched
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const result = await adapter.voidTransaction(
      client,
      workspaceId,
      transactionId,
      accountId,
      'confirmed',
      1,
    );

    expect(result).toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(2); // lock + update only
    expect(
      executedQueries.some((q) =>
        q.includes('insert into public.ledger_postings'),
      ),
    ).toBe(false);
    expect(
      executedQueries.some((q) => q.includes('set constraints all immediate')),
    ).toBe(false);
  });
});
