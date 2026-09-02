import { describe, expect, it } from 'vitest';
import {
  createBudgetListQuery,
  BudgetQueryValidationError,
} from '../../src/budgets/budget-query.js';
const workspaceId = '00000000-0000-0000-0000-000000000001';
describe('budget query validation', () => {
  it('binds filters into a valid query', () =>
    expect(
      createBudgetListQuery({
        workspaceId,
        fromParam: '2026-01-01',
        toParam: '2026-02-01',
      }),
    ).toMatchObject({ from: '2026-01-01', to: '2026-02-01' }));
  it('rejects malformed limit and reversed dates', () =>
    expect(() =>
      createBudgetListQuery({
        workspaceId,
        limitParam: '0',
        fromParam: '2026-02-01',
        toParam: '2026-01-01',
      }),
    ).toThrow(BudgetQueryValidationError));
});
