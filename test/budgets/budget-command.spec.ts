import { describe, expect, it } from 'vitest';
import {
  createBudgetCommand,
  updateBudgetCommand,
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

describe('updateBudgetCommand', () => {
  it('accepts valid updates with name, method, or both', () => {
    expect(updateBudgetCommand({ name: 'Renamed' })).toEqual({
      name: 'Renamed',
    });
    expect(updateBudgetCommand({ method: 'cash_flow' })).toEqual({
      method: 'cash_flow',
    });
    expect(updateBudgetCommand({ name: 'x', method: 'zero_based' })).toEqual({
      name: 'x',
      method: 'zero_based',
    });
    expect(
      updateBudgetCommand({ name: 'a'.repeat(120), method: 'hybrid' }),
    ).toEqual({
      name: 'a'.repeat(120),
      method: 'hybrid',
    });
  });

  it('rejects empty object (minProperties: 1)', () => {
    expect(() => updateBudgetCommand({})).toThrow(BudgetCommandValidationError);
  });

  it('rejects unknown properties', () => {
    expect(() =>
      updateBudgetCommand({ name: 'Plan', unknownField: true }),
    ).toThrow(BudgetCommandValidationError);
  });

  it('rejects immutable fields (periodStart, periodEnd, currency)', () => {
    expect(() => updateBudgetCommand({ periodStart: '2026-01-01' })).toThrow(
      BudgetCommandValidationError,
    );
    expect(() => updateBudgetCommand({ periodEnd: '2026-02-01' })).toThrow(
      BudgetCommandValidationError,
    );
    expect(() => updateBudgetCommand({ currency: 'USD' })).toThrow(
      BudgetCommandValidationError,
    );
  });

  it('rejects name of 0 or >120 characters', () => {
    expect(() => updateBudgetCommand({ name: '' })).toThrow(
      BudgetCommandValidationError,
    );
    expect(() => updateBudgetCommand({ name: 'a'.repeat(121) })).toThrow(
      BudgetCommandValidationError,
    );
  });

  it('rejects invalid method', () => {
    expect(() => updateBudgetCommand({ method: 'not_a_method' })).toThrow(
      BudgetCommandValidationError,
    );
  });

  it('rejects non-object inputs', () => {
    expect(() => updateBudgetCommand(null)).toThrow(
      BudgetCommandValidationError,
    );
    expect(() => updateBudgetCommand([])).toThrow(BudgetCommandValidationError);
    expect(() => updateBudgetCommand('string')).toThrow(
      BudgetCommandValidationError,
    );
  });
});
