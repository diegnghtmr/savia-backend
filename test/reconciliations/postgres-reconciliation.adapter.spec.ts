import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';
import { PostgresReconciliationAdapter } from '../../src/reconciliations/postgres-reconciliation.adapter.js';

describe('PostgresReconciliationAdapter completion serialization', () => {
  it('locks candidate postings and transactions during validation', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('locked_transactions')) return { rows: [] };
        return { rows: [] };
      }),
    } as unknown as TransactionClient;

    await new PostgresReconciliationAdapter().validateCompletionTransactions(
      client,
      'workspace',
      'account',
      ['transaction'],
      '2026-08-30',
    );

    expect(
      queries.some(
        (query) =>
          query.includes('ledger_postings') && query.includes('for update'),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.includes('locked_transactions') && query.includes('for update'),
      ),
    ).toBe(true);
  });
});
