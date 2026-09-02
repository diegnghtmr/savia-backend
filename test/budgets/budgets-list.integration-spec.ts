import { describe, expect, it } from 'vitest';
import { createBudgetListQuery } from '../../src/budgets/budget-query.js';
describe('budget list integration contract', () => {
  it('accepts bounded pagination filters', () =>
    expect(
      createBudgetListQuery({
        workspaceId: '00000000-0000-0000-0000-000000000001',
        limitParam: '2',
      }).limit,
    ).toBe(2));
});
