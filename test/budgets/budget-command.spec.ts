import { describe, expect, it } from 'vitest';
import {
  createBudgetCommand,
  updateBudgetCommand,
  updateBudgetAllocationsCommand,
  BudgetCommandValidationError,
} from '../../src/budgets/budget-command.js';

const CATEGORY_ID = '00000000-0000-0000-0000-000000000001';
const TARGET_ID = '00000000-0000-0000-0000-000000000002';

const validAllocation = (overrides: Record<string, unknown> = {}) => ({
  categoryId: CATEGORY_ID,
  planned: { amountMinor: '1000', currency: 'USD' },
  rolloverPolicy: 'none',
  ...overrides,
});

function violationsFor(input: unknown) {
  try {
    updateBudgetAllocationsCommand(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetCommandValidationError);
    return (error as BudgetCommandValidationError).violations;
  }
  throw new Error('Expected budget allocation validation to fail');
}

function expectViolation(input: unknown, field: string, code: string): void {
  expect(violationsFor(input)).toEqual(
    expect.arrayContaining([expect.objectContaining({ field, code })]),
  );
}

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

describe('updateBudgetAllocationsCommand', () => {
  it.each([null, [], 'body'])('rejects non-object request bodies', (input) => {
    expectViolation(input, 'body', 'invalid-type');
  });

  it.each([null, [], 'item'])(
    'rejects non-object allocation items',
    (input) => {
      expectViolation(
        { allocations: [input] },
        'allocations[0]',
        'invalid-type',
      );
    },
  );

  it.each([
    ['missing', { categoryId: undefined }],
    ['malformed', { categoryId: 'bad' }],
  ])('rejects %s category IDs', (_name, allocation) => {
    expectViolation(
      { allocations: [validAllocation(allocation)] },
      'allocations[0].categoryId',
      'invalid-format',
    );
  });

  it('rejects duplicate category IDs', () => {
    expectViolation(
      { allocations: [validAllocation(), validAllocation()] },
      'allocations[1].categoryId',
      'duplicate',
    );
  });

  it.each([undefined, null, [], 'money'])(
    'rejects non-object planned values: %p',
    (planned) => {
      expectViolation(
        { allocations: [validAllocation({ planned })] },
        'allocations[0].planned',
        'invalid-type',
      );
    },
  );

  it('rejects unknown properties inside planned', () => {
    expectViolation(
      {
        allocations: [
          validAllocation({
            planned: { amountMinor: '1', currency: 'USD', extra: true },
          }),
        ],
      },
      'allocations[0].planned.extra',
      'not-allowed',
    );
  });

  it.each([
    ['missing', undefined, 'required'],
    ['non-string', 123, 'invalid-type'],
    ['null character', '1\0', 'invalid-characters'],
    ['empty', '', 'required'],
    ['whitespace-only', '   ', 'required'],
    ['malformed', '1.5', 'invalid-format'],
    ['malformed', 'abc', 'invalid-format'],
    ['below int64', '-9223372036854775809', 'invalid-range'],
    ['above int64', '9223372036854775808', 'invalid-range'],
  ])('rejects %s amountMinor', (_name, amountMinor, code) => {
    expectViolation(
      {
        allocations: [
          validAllocation({ planned: { amountMinor, currency: 'USD' } }),
        ],
      },
      'allocations[0].planned.amountMinor',
      code,
    );
  });

  it.each([
    ['missing', undefined, 'required'],
    ['non-string', 123, 'required'],
    ['empty', '', 'required'],
    ['unsupported', 'XYZ', 'invalid-currency'],
  ])('rejects %s currency', (_name, currency, code) => {
    expectViolation(
      {
        allocations: [
          validAllocation({ planned: { amountMinor: '1', currency } }),
        ],
      },
      'allocations[0].planned.currency',
      code,
    );
  });

  it('normalizes currency case and amount whitespace like other Money endpoints', () => {
    expect(
      updateBudgetAllocationsCommand({
        allocations: [
          validAllocation({
            planned: { amountMinor: '  1000  ', currency: 'usd' },
          }),
        ],
      }),
    ).toEqual({
      allocations: [
        {
          categoryId: CATEGORY_ID,
          planned: { amountMinor: '1000', currency: 'USD' },
          rolloverPolicy: 'none',
        },
      ],
    });
  });

  it.each([
    ['unsupported', 'future'],
    ['missing', undefined],
  ])('rejects %s rollover policies', (_name, rolloverPolicy) => {
    expectViolation(
      { allocations: [validAllocation({ rolloverPolicy })] },
      'allocations[0].rolloverPolicy',
      'unsupported',
    );
  });

  it('rejects malformed rollover targets', () => {
    expectViolation(
      { allocations: [validAllocation({ rolloverTargetId: 'bad' })] },
      'allocations[0].rolloverTargetId',
      'invalid-format',
    );
  });

  it('accepts an explicit null target for a non-target policy', () => {
    expect(
      updateBudgetAllocationsCommand({
        allocations: [validAllocation({ rolloverTargetId: null })],
      }).allocations[0].rolloverTargetId,
    ).toBeNull();
  });

  it.each([undefined, null])('rejects to_fund with target %p', (target) => {
    expectViolation(
      {
        allocations: [
          validAllocation({
            rolloverPolicy: 'to_fund',
            rolloverTargetId: target,
          }),
        ],
      },
      'allocations[0].rolloverTargetId',
      'unsupported',
    );
  });

  it('requires a target for to_category', () => {
    expectViolation(
      { allocations: [validAllocation({ rolloverPolicy: 'to_category' })] },
      'allocations[0].rolloverTargetId',
      'required',
    );
  });

  it('emits every valid allocation, including zero planned amounts', () => {
    expect(
      updateBudgetAllocationsCommand({
        allocations: [
          validAllocation({ planned: { amountMinor: '0', currency: 'USD' } }),
          validAllocation({
            categoryId: TARGET_ID,
            planned: { amountMinor: '-1', currency: 'USD' },
          }),
        ],
      }).allocations,
    ).toHaveLength(2);
  });
});
