import { describe, expect, it, vi } from 'vitest';
import { PostgresBudgetAdapter } from '../../src/budgets/postgres-budget.adapter.js';
import type { TransactionClient } from '../../src/platform/pg-transaction.js';

describe('PostgresBudgetAdapter.updateBudget', () => {
  it('rejects any result other than exactly one affected row', async () => {
    const client: TransactionClient = {
      query: vi.fn().mockResolvedValue({ rowCount: 2, rows: [] }),
    };

    await expect(
      new PostgresBudgetAdapter().updateBudget(
        client,
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        { name: 'Updated' },
        1,
      ),
    ).rejects.toThrow('Budget update affected 2 rows');
  });
});
