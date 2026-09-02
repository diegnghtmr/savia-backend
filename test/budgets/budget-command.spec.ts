import { describe, expect, it } from 'vitest';
import {
  createBudgetCommand,
  BudgetCommandValidationError,
} from '../../src/budgets/budget-command.js';
describe('budget command validation', () => {
  it('accepts a six-month UTC period and optional source', () =>
    expect(
      createBudgetCommand({
        name: 'Plan',
        method: 'cash_flow',
        periodStart: '2026-01-01',
        periodEnd: '2026-07-01',
        copyFromBudgetId: null,
      }),
    ).toMatchObject({ name: 'Plan', method: 'cash_flow' }));
  it.each([
    { periodEnd: '2026-01-01' },
    { periodEnd: '2025-12-31' },
    { periodEnd: '2027-01-03' },
  ])('rejects invalid period $periodEnd', ({ periodEnd }) =>
    expect(() =>
      createBudgetCommand({
        name: 'Plan',
        method: 'hybrid',
        periodStart: '2026-01-01',
        periodEnd,
      }),
    ).toThrow(BudgetCommandValidationError),
  );
  it('rejects unknown properties and non UUID source', () =>
    expect(() =>
      createBudgetCommand({
        name: 'Plan',
        method: 'hybrid',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-02',
        extra: true,
        copyFromBudgetId: 'bad',
      }),
    ).toThrow(BudgetCommandValidationError));
});
