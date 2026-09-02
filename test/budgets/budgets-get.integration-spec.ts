import { describe, expect, it } from 'vitest';
import { validateBudgetId } from '../../src/budgets/budget-query.js';
describe('budget get integration contract', () => {
  it('normalizes UUID path identifiers', () =>
    expect(validateBudgetId('00000000-0000-0000-0000-000000000001')).toBe(
      '00000000-0000-0000-0000-000000000001',
    ));
});
