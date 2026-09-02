import { describe, expect, it } from 'vitest';
import { createBudgetCommand } from '../../src/budgets/budget-command.js';
describe('budget create integration contract', () => {
  it('validates creation inputs before database work', () =>
    expect(
      createBudgetCommand({
        name: 'Monthly',
        method: 'envelope',
        periodStart: '2026-01-01',
        periodEnd: '2026-02-01',
        copyFromBudgetId: null,
      }).name,
    ).toBe('Monthly'));
});
