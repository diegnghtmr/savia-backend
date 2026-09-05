import { describe, expect, it } from 'vitest';
import { runScenarioEngine } from '../../src/scenarios/scenario-engine.js';

describe('scenario-engine', () => {
  const baseInput = {
    periodStart: '2025-10-01',
    periodEnd: '2026-09-04',
    baseCurrency: 'USD',
    monthlyIncomeMinor: 100000n,
    monthlyExpensesMinor: 60000n,
    netWorthMinor: 500000n,
    flowRows: [],
    accountBalances: [],
    debtBalances: [],
    rates: new Map<string, string>(),
  };

  it('applies income_change with amountMinor correctly', () => {
    // Baseline: income 100000, expenses 60000, savings 40000, netWorth 500000
    // Assumption: +25000 income
    // Hand-derived arithmetic:
    // Projected income = 100000 + 25000 = 125000
    // Projected expenses = 60000
    // Projected savings = 125000 - 60000 = 65000
    // Difference income = +25000
    // Difference savings = +25000
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'income_change',
          value: { amountMinor: '25000' },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.baseline.monthlyIncomeMinor).toBe('100000');
    expect(result.baseline.monthlyExpensesMinor).toBe('60000');
    expect(result.baseline.monthlySavingsCapacityMinor).toBe('40000');
    expect(result.projected.monthlyIncomeMinor).toBe('125000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('65000');
    expect(result.difference.monthlyIncomeMinor).toBe('25000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('25000');
    expect(result.risks).toEqual([]);
  });

  it('applies income_change with percent correctly', () => {
    // Baseline: income 100000, expenses 60000, savings 40000
    // Assumption: percent: 10
    // Hand-derived arithmetic:
    // Delta = roundDivHalfAwayFromZero(100000 * 10 * 100, 10000) = 10000
    // Projected income = 100000 + 10000 = 110000
    // Projected savings = 110000 - 60000 = 50000
    // Difference income = 10000, difference savings = 10000
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'income_change',
          value: { percent: 10 },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.monthlyIncomeMinor).toBe('110000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('50000');
    expect(result.difference.monthlyIncomeMinor).toBe('10000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('10000');
    expect(result.risks).toEqual([]);
  });

  it('applies expense_change with amountMinor and percent correctly', () => {
    // Baseline: income 100000, expenses 60000
    // Test amountMinor: +15000
    // Hand-derived arithmetic:
    // Projected expenses = 60000 + 15000 = 75000
    // Projected savings = 100000 - 75000 = 25000
    // Difference expenses = +15000, difference savings = -15000 (signed, not clamped)
    const resultAmt = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'expense_change',
          value: { amountMinor: '15000' },
        },
      ],
    });

    expect(resultAmt.status).toBe('completed');
    expect(resultAmt.projected.monthlyExpensesMinor).toBe('75000');
    expect(resultAmt.projected.monthlySavingsCapacityMinor).toBe('25000');
    expect(resultAmt.difference.monthlyExpensesMinor).toBe('15000');
    expect(resultAmt.difference.monthlySavingsCapacityMinor).toBe('-15000');

    // Test percent: 20%
    // Delta = roundDivHalfAwayFromZero(60000 * 20 * 100, 10000) = 12000
    // Projected expenses = 60000 + 12000 = 72000
    // Projected savings = 100000 - 72000 = 28000
    // Difference expenses = +12000, difference savings = -12000
    const resultPct = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'expense_change',
          value: { percent: 20 },
        },
      ],
    });

    expect(resultPct.status).toBe('completed');
    expect(resultPct.projected.monthlyExpensesMinor).toBe('72000');
    expect(resultPct.projected.monthlySavingsCapacityMinor).toBe('28000');
    expect(resultPct.difference.monthlyExpensesMinor).toBe('12000');
    expect(resultPct.difference.monthlySavingsCapacityMinor).toBe('-12000');
  });

  it('applies purchase correctly (leaves monthly figures alone, reduces net worth)', () => {
    // Baseline: netWorth 500000, monthly figures 100000 / 60000 / 40000
    // Assumption: purchase amountMinor: 80000
    // Hand-derived arithmetic:
    // Projected net worth = 500000 - 80000 = 420000
    // Monthly figures remain: income 100000, expenses 60000, savings 40000
    // Difference netWorth = -80000, difference monthly figures = 0
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'purchase',
          value: { amountMinor: '80000' },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.netWorthMinor).toBe('420000');
    expect(result.projected.monthlyIncomeMinor).toBe('100000');
    expect(result.projected.monthlyExpensesMinor).toBe('60000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('40000');
    expect(result.difference.netWorthMinor).toBe('-80000');
    expect(result.difference.monthlyIncomeMinor).toBe('0');
    expect(result.difference.monthlyExpensesMinor).toBe('0');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('0');
    expect(result.risks).toEqual([]);
  });

  it('applies new_debt correctly (principal reduces net worth, payment adds to monthly expenses)', () => {
    // Baseline: netWorth 500000, expenses 60000, income 100000, savings 40000
    // Assumption: principal 200000, payment 10000
    // Hand-derived arithmetic:
    // Projected net worth = 500000 - 200000 = 300000
    // Projected expenses = 60000 + 10000 = 70000
    // Projected savings = 100000 - 70000 = 30000
    // Difference netWorth = -200000, difference expenses = +10000, difference savings = -10000
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'new_debt',
          value: {
            principalMinor: '200000',
            monthlyPaymentMinor: '10000',
          },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.netWorthMinor).toBe('300000');
    expect(result.projected.monthlyExpensesMinor).toBe('70000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('30000');
    expect(result.difference.netWorthMinor).toBe('-200000');
    expect(result.difference.monthlyExpensesMinor).toBe('10000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('-10000');
    expect(result.risks).toEqual([]);
  });

  it('applies extra_debt_payment correctly (adds to monthly expenses)', () => {
    // Baseline: expenses 60000, income 100000, savings 40000
    // Assumption: amountMinor 5000
    // Hand-derived arithmetic:
    // Projected expenses = 60000 + 5000 = 65000
    // Projected savings = 100000 - 65000 = 35000
    // Difference expenses = +5000, difference savings = -5000
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'extra_debt_payment',
          value: { amountMinor: '5000' },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.monthlyExpensesMinor).toBe('65000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('35000');
    expect(result.difference.monthlyExpensesMinor).toBe('5000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('-5000');
    expect(result.risks).toEqual([]);
  });

  it('applies cancel_subscription correctly (subtracts from monthly expenses)', () => {
    // Baseline: expenses 60000, income 100000, savings 40000
    // Assumption: monthlyAmountMinor 3000
    // Hand-derived arithmetic:
    // Projected expenses = 60000 - 3000 = 57000
    // Projected savings = 100000 - 57000 = 43000
    // Difference expenses = -3000, difference savings = +3000
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'cancel_subscription',
          value: { monthlyAmountMinor: '3000' },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.monthlyExpensesMinor).toBe('57000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('43000');
    expect(result.difference.monthlyExpensesMinor).toBe('-3000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('3000');
    expect(result.risks).toEqual([]);
  });

  it('applies exchange_rate_change correctly (replaces rate for conversion)', () => {
    // Workspace baseCurrency: USD.
    // Account 1: 10000 EUR. Baseline rate EUR->USD is 1.2 -> 12000 USD.
    // Assumption: exchange_rate_change EUR->USD rate 1.5.
    // Hand-derived arithmetic:
    // Baseline netWorth = 10000 * 1.2 = 12000 USD
    // Projected netWorth = 10000 * 1.5 = 15000 USD
    // Difference netWorth = 15000 - 12000 = +3000 USD
    const result = runScenarioEngine({
      periodStart: '2025-10-01',
      periodEnd: '2026-09-04',
      baseCurrency: 'USD',
      accountBalances: [{ currency: 'EUR', nativeBalanceMinor: '10000' }],
      debtBalances: [],
      rates: new Map([['EUR:USD', '1.2']]),
      assumptions: [
        {
          type: 'exchange_rate_change',
          value: {
            fromCurrency: 'EUR',
            toCurrency: 'USD',
            rate: '1.5',
          },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.baseline.netWorthMinor).toBe('12000');
    expect(result.projected.netWorthMinor).toBe('15000');
    expect(result.difference.netWorthMinor).toBe('3000');
    expect(result.risks).toEqual([]);
  });

  it('applies savings_contribution correctly (adds to monthly expenses, net worth unchanged)', () => {
    // Baseline: netWorth 500000, expenses 60000, income 100000, savings 40000
    // Assumption: monthlyAmountMinor 10000
    // Hand-derived arithmetic:
    // Projected expenses = 60000 + 10000 = 70000
    // Projected savings = 100000 - 70000 = 30000
    // Projected net worth = 500000 (unchanged, money moved not left)
    // Difference expenses = +10000, difference savings = -10000, difference net worth = 0
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'savings_contribution',
          value: { monthlyAmountMinor: '10000' },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.monthlyExpensesMinor).toBe('70000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('30000');
    expect(result.projected.netWorthMinor).toBe('500000');
    expect(result.difference.monthlyExpensesMinor).toBe('10000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('-10000');
    expect(result.difference.netWorthMinor).toBe('0');
    expect(result.risks).toEqual([]);
  });

  it('applies income_gap correctly (reduces annualised income by months spread over projected monthly income)', () => {
    // Baseline: income 100000, expenses 60000, savings 40000
    // Assumption: months: 3
    // Hand-derived arithmetic:
    // Baseline annualised income = 100000 * 12 = 1200000
    // Gap reduction for 3 months = 3 * 100000 = 300000
    // Spread over 12 months = 300000 / 12 = 25000
    // (Or: roundDivHalfAwayFromZero(100000 * 3, 12) = 25000)
    // Projected income = 100000 - 25000 = 75000
    // Projected savings = 75000 - 60000 = 15000
    // Difference income = -25000, difference savings = -25000
    const result = runScenarioEngine({
      ...baseInput,
      assumptions: [
        {
          type: 'income_gap',
          value: { months: 3 },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.projected.monthlyIncomeMinor).toBe('75000');
    expect(result.projected.monthlySavingsCapacityMinor).toBe('15000');
    expect(result.difference.monthlyIncomeMinor).toBe('-25000');
    expect(result.difference.monthlySavingsCapacityMinor).toBe('-25000');
    expect(result.risks).toEqual([]);
  });

  describe('Unapplicable assumptions and risks', () => {
    it('records risks for each of the nine types when required fields are missing', () => {
      const assumptions = [
        { type: 'income_change' as const, value: {} },
        { type: 'expense_change' as const, value: {} },
        { type: 'purchase' as const, value: {} },
        { type: 'new_debt' as const, value: { principalMinor: '500' } },
        { type: 'extra_debt_payment' as const, value: {} },
        { type: 'cancel_subscription' as const, value: {} },
        {
          type: 'exchange_rate_change' as const,
          value: { fromCurrency: 'EUR' },
        },
        { type: 'savings_contribution' as const, value: {} },
        { type: 'income_gap' as const, value: { months: 0 } },
      ];

      const result = runScenarioEngine({
        ...baseInput,
        assumptions,
      });

      // All failed: zero assumptions could be applied
      expect(result.status).toBe('failed');
      expect(result.projected).toEqual(result.baseline);
      expect(result.difference.monthlyIncomeMinor).toBe('0');
      expect(result.difference.monthlyExpensesMinor).toBe('0');
      expect(result.difference.monthlySavingsCapacityMinor).toBe('0');
      expect(result.difference.netWorthMinor).toBe('0');

      expect(result.risks).toHaveLength(9);
      expect(result.risks[0]).toBe(
        'assumptions[0] (income_change): value is missing amountMinor or percent',
      );
      expect(result.risks[1]).toBe(
        'assumptions[1] (expense_change): value is missing amountMinor or percent',
      );
      expect(result.risks[2]).toBe(
        'assumptions[2] (purchase): value is missing amountMinor',
      );
      expect(result.risks[3]).toBe(
        'assumptions[3] (new_debt): value is missing monthlyPaymentMinor',
      );
      expect(result.risks[4]).toBe(
        'assumptions[4] (extra_debt_payment): value is missing amountMinor',
      );
      expect(result.risks[5]).toBe(
        'assumptions[5] (cancel_subscription): value is missing monthlyAmountMinor',
      );
      expect(result.risks[6]).toBe(
        'assumptions[6] (exchange_rate_change): value is missing toCurrency, rate',
      );
      expect(result.risks[7]).toBe(
        'assumptions[7] (savings_contribution): value is missing monthlyAmountMinor',
      );
      expect(result.risks[8]).toBe(
        'assumptions[8] (income_gap): value is missing months',
      );
    });

    it('returns completed when at least one assumption applies, listing unapplicable in risks', () => {
      const result = runScenarioEngine({
        ...baseInput,
        assumptions: [
          { type: 'income_change', value: { amountMinor: '10000' } },
          { type: 'purchase', value: {} },
        ],
      });

      expect(result.status).toBe('completed');
      expect(result.projected.monthlyIncomeMinor).toBe('110000');
      expect(result.risks).toEqual([
        'assumptions[1] (purchase): value is missing amountMinor',
      ]);
    });
  });

  describe('Negative differences (worse projection)', () => {
    it('preserves signed negative difference fields when position worsens without clamping', () => {
      // Baseline: income 100000, expenses 60000, savings 40000, netWorth 500000
      // Assumption: expense_change +50000, purchase 100000
      // Hand-derived arithmetic:
      // Projected expenses = 60000 + 50000 = 110000
      // Projected savings = 100000 - 110000 = -10000
      // Projected netWorth = 500000 - 100000 = 400000
      // Difference expenses = +50000
      // Difference savings = -10000 - 40000 = -50000 (NEGATIVE, unclamped!)
      // Difference netWorth = 400000 - 500000 = -100000 (NEGATIVE, unclamped!)
      const result = runScenarioEngine({
        ...baseInput,
        assumptions: [
          { type: 'expense_change', value: { amountMinor: '50000' } },
          { type: 'purchase', value: { amountMinor: '100000' } },
        ],
      });

      expect(result.status).toBe('completed');
      expect(result.difference.monthlyExpensesMinor).toBe('50000');
      expect(result.difference.monthlySavingsCapacityMinor).toBe('-50000');
      expect(result.difference.netWorthMinor).toBe('-100000');
    });
  });

  describe('Serialization and amount format', () => {
    it('ensures JSON.stringify does not throw and all amounts match ^-?[0-9]+$', () => {
      const result = runScenarioEngine({
        ...baseInput,
        assumptions: [
          { type: 'income_change', value: { amountMinor: '20000' } },
        ],
      });

      expect(() => JSON.stringify(result)).not.toThrow();

      const regex = /^-?[0-9]+$/;
      for (const set of [
        result.baseline,
        result.projected,
        result.difference,
      ]) {
        expect(set.monthlyIncomeMinor).toMatch(regex);
        expect(set.monthlyExpensesMinor).toMatch(regex);
        expect(set.monthlySavingsCapacityMinor).toMatch(regex);
        expect(set.netWorthMinor).toMatch(regex);
      }
    });
  });
});
