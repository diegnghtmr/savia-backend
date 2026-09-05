import { multiplyMinorByRate } from '../platform/currency-conversion.js';
import {
  buildMonthlySavingsCapacity,
  type ConvertedFlowRow,
} from '../platform/monthly-capacity.js';
import { roundDivHalfAwayFromZero } from '../platform/percentage-change.js';
import type {
  ScenarioAssumption,
  ScenarioFigureSet,
  ScenarioRunResult,
} from './scenario.port.js';

export type { ScenarioFigureSet, ScenarioRunResult };

export interface RawFlowRow {
  readonly type: 'income' | 'expense' | 'refund';
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
}

export interface RawAccountBalance {
  readonly currency: string;
  readonly nativeBalanceMinor: string;
}

export interface RawDebtBalance {
  readonly currency: string;
  readonly outstandingBalanceMinor: string;
}

export interface ScenarioEngineInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly baseCurrency: string;
  readonly monthlyIncomeMinor?: bigint;
  readonly monthlyExpensesMinor?: bigint;
  readonly netWorthMinor?: bigint;
  readonly flowRows?: readonly RawFlowRow[];
  readonly accountBalances?: readonly RawAccountBalance[];
  readonly debtBalances?: readonly RawDebtBalance[];
  readonly rates?: ReadonlyMap<string, string>;
  readonly assumptions: readonly ScenarioAssumption[];
}

export type ScenarioEngineOutcome =
  | { readonly kind: 'ok'; readonly run: ScenarioRunResult }
  | {
      readonly kind: 'missing_rate';
      readonly fromCurrency: string;
      readonly toCurrency: string;
    };

function parseAmountMinor(val: unknown): string | null {
  if (typeof val === 'string' && /^-?[0-9]+$/.test(val.trim())) {
    return val.trim();
  }
  return null;
}

function parseExchangeRate(val: unknown): string | null {
  if (typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    return null;
  }
  if (!/[1-9]/.test(trimmed)) {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return trimmed;
}

function parsePercent(val: unknown): number | null {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return null;
  }
  const scaled = Math.round(val * 100);
  if (!Number.isSafeInteger(scaled)) {
    return null;
  }
  return val;
}

function parseMonths(val: unknown): number | null {
  if (typeof val === 'number' && Number.isInteger(val) && val >= 1) {
    return val;
  }
  return null;
}

function convertAmount(
  amountMinor: string,
  fromCurrency: string,
  toCurrency: string,
  rates: ReadonlyMap<string, string>,
): { amount: bigint } | { missingRate: { from: string; to: string } } {
  if (fromCurrency === toCurrency) {
    return { amount: BigInt(amountMinor) };
  }
  const rateKey = `${fromCurrency}:${toCurrency}`;
  const rate = rates.get(rateKey);
  if (!rate) {
    return { missingRate: { from: fromCurrency, to: toCurrency } };
  }
  return { amount: BigInt(multiplyMinorByRate(amountMinor, rate)) };
}

export function runScenarioEngine(
  input: ScenarioEngineInput,
): ScenarioRunResult {
  const outcome = evaluateScenario(input);
  if (outcome.kind === 'missing_rate') {
    throw new Error(
      `Missing exchange rate from ${outcome.fromCurrency} to ${outcome.toCurrency}`,
    );
  }
  return outcome.run;
}

export function evaluateScenario(
  input: ScenarioEngineInput,
): ScenarioEngineOutcome {
  const baseRates = input.rates ?? new Map<string, string>();

  // Determine baseline figures
  let baselineIncome = input.monthlyIncomeMinor ?? 0n;
  let baselineExpenses = input.monthlyExpensesMinor ?? 0n;
  let baselineNetWorth = input.netWorthMinor ?? 0n;

  if (input.flowRows !== undefined && input.monthlyIncomeMinor === undefined) {
    const convertedRows: ConvertedFlowRow[] = [];
    for (const row of input.flowRows) {
      const res = convertAmount(
        row.amountMinor,
        row.currency,
        input.baseCurrency,
        baseRates,
      );
      if ('missingRate' in res) {
        return {
          kind: 'missing_rate',
          fromCurrency: res.missingRate.from,
          toCurrency: res.missingRate.to,
        };
      }
      convertedRows.push({
        type: row.type,
        amountMinor: res.amount,
        occurredAt: row.occurredAt,
      });
    }

    const points = buildMonthlySavingsCapacity(
      input.periodStart,
      input.periodEnd,
      convertedRows,
    );
    const monthsCount = points.length > 0 ? BigInt(points.length) : 12n;
    let totalIncome = 0n;
    let totalExpenses = 0n;
    for (const p of points) {
      totalIncome += p.incomeMinor;
      totalExpenses += p.expensesMinor;
    }
    baselineIncome = roundDivHalfAwayFromZero(totalIncome, monthsCount);
    baselineExpenses = roundDivHalfAwayFromZero(totalExpenses, monthsCount);
  }

  if (
    (input.accountBalances !== undefined || input.debtBalances !== undefined) &&
    input.netWorthMinor === undefined
  ) {
    let totalAssets = 0n;
    for (const acct of input.accountBalances ?? []) {
      const res = convertAmount(
        acct.nativeBalanceMinor,
        acct.currency,
        input.baseCurrency,
        baseRates,
      );
      if ('missingRate' in res) {
        return {
          kind: 'missing_rate',
          fromCurrency: res.missingRate.from,
          toCurrency: res.missingRate.to,
        };
      }
      totalAssets += res.amount;
    }

    let totalDebts = 0n;
    for (const debt of input.debtBalances ?? []) {
      const res = convertAmount(
        debt.outstandingBalanceMinor,
        debt.currency,
        input.baseCurrency,
        baseRates,
      );
      if ('missingRate' in res) {
        return {
          kind: 'missing_rate',
          fromCurrency: res.missingRate.from,
          toCurrency: res.missingRate.to,
        };
      }
      totalDebts += res.amount;
    }
    baselineNetWorth = totalAssets - totalDebts;
  }

  const baselineSavings = baselineIncome - baselineExpenses;
  const baseline: ScenarioFigureSet = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseCurrency: input.baseCurrency,
    monthlyIncomeMinor: baselineIncome.toString(),
    monthlyExpensesMinor: baselineExpenses.toString(),
    monthlySavingsCapacityMinor: baselineSavings.toString(),
    netWorthMinor: baselineNetWorth.toString(),
  };

  // Inspect exchange_rate_change assumptions to build projected rates
  const projectedRates = new Map<string, string>(baseRates);
  const riskByIndex = new Map<number, string>();
  let appliedCount = 0;

  // Track applied status per assumption index
  const isApplied: boolean[] = new Array(input.assumptions.length).fill(false);

  for (let i = 0; i < input.assumptions.length; i += 1) {
    const a = input.assumptions[i];
    if (a.type === 'exchange_rate_change') {
      const val = (a.value ?? {}) as Record<string, unknown>;
      const fromCurr =
        typeof val.fromCurrency === 'string' &&
        val.fromCurrency.trim().length === 3
          ? val.fromCurrency.trim().toUpperCase()
          : null;
      const toCurr =
        typeof val.toCurrency === 'string' && val.toCurrency.trim().length === 3
          ? val.toCurrency.trim().toUpperCase()
          : null;
      const rateStr = parseExchangeRate(val.rate);

      if (fromCurr && toCurr && rateStr) {
        projectedRates.set(`${fromCurr}:${toCurr}`, rateStr);
        isApplied[i] = true;
        appliedCount += 1;
      } else {
        const missing: string[] = [];
        if (!fromCurr) missing.push('fromCurrency');
        if (!toCurr) missing.push('toCurrency');
        if (!rateStr) missing.push('rate');
        riskByIndex.set(
          i,
          `assumptions[${i}] (exchange_rate_change): value is missing ${missing.join(', ')}`,
        );
      }
    }
  }

  // If exchange rate changes were applied and we have raw inputs, re-evaluate base projected figures
  let projectedIncome = baselineIncome;
  let projectedExpenses = baselineExpenses;
  let projectedNetWorth = baselineNetWorth;

  if (input.flowRows !== undefined && input.flowRows.length > 0) {
    const convertedRows: ConvertedFlowRow[] = [];
    for (const row of input.flowRows) {
      const res = convertAmount(
        row.amountMinor,
        row.currency,
        input.baseCurrency,
        projectedRates,
      );
      if ('missingRate' in res) {
        return {
          kind: 'missing_rate',
          fromCurrency: res.missingRate.from,
          toCurrency: res.missingRate.to,
        };
      }
      convertedRows.push({
        type: row.type,
        amountMinor: res.amount,
        occurredAt: row.occurredAt,
      });
    }
    const points = buildMonthlySavingsCapacity(
      input.periodStart,
      input.periodEnd,
      convertedRows,
    );
    const monthsCount = points.length > 0 ? BigInt(points.length) : 12n;
    let totalIncome = 0n;
    let totalExpenses = 0n;
    for (const p of points) {
      totalIncome += p.incomeMinor;
      totalExpenses += p.expensesMinor;
    }
    projectedIncome = roundDivHalfAwayFromZero(totalIncome, monthsCount);
    projectedExpenses = roundDivHalfAwayFromZero(totalExpenses, monthsCount);
  }

  if (
    (input.accountBalances !== undefined && input.accountBalances.length > 0) ||
    (input.debtBalances !== undefined && input.debtBalances.length > 0)
  ) {
    let totalAssets = 0n;
    for (const acct of input.accountBalances ?? []) {
      const res = convertAmount(
        acct.nativeBalanceMinor,
        acct.currency,
        input.baseCurrency,
        projectedRates,
      );
      if ('missingRate' in res) {
        return {
          kind: 'missing_rate',
          fromCurrency: res.missingRate.from,
          toCurrency: res.missingRate.to,
        };
      }
      totalAssets += res.amount;
    }

    let totalDebts = 0n;
    for (const debt of input.debtBalances ?? []) {
      const res = convertAmount(
        debt.outstandingBalanceMinor,
        debt.currency,
        input.baseCurrency,
        projectedRates,
      );
      if ('missingRate' in res) {
        return {
          kind: 'missing_rate',
          fromCurrency: res.missingRate.from,
          toCurrency: res.missingRate.to,
        };
      }
      totalDebts += res.amount;
    }
    projectedNetWorth = totalAssets - totalDebts;
  }

  // Apply remaining assumptions
  for (let i = 0; i < input.assumptions.length; i += 1) {
    const a = input.assumptions[i];
    if (a.type === 'exchange_rate_change') {
      continue; // Handled above
    }

    const val = (a.value ?? {}) as Record<string, unknown>;

    switch (a.type) {
      case 'income_change': {
        const amt = parseAmountMinor(val.amountMinor);
        const pct = parsePercent(val.percent);
        if (amt !== null) {
          projectedIncome += BigInt(amt);
          isApplied[i] = true;
          appliedCount += 1;
        } else if (pct !== null) {
          const delta = roundDivHalfAwayFromZero(
            baselineIncome * BigInt(Math.round(pct * 100)),
            10000n,
          );
          projectedIncome += delta;
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (income_change): value is missing amountMinor or percent`,
          );
        }
        break;
      }

      case 'expense_change': {
        const amt = parseAmountMinor(val.amountMinor);
        const pct = parsePercent(val.percent);
        if (amt !== null) {
          projectedExpenses += BigInt(amt);
          isApplied[i] = true;
          appliedCount += 1;
        } else if (pct !== null) {
          const delta = roundDivHalfAwayFromZero(
            baselineExpenses * BigInt(Math.round(pct * 100)),
            10000n,
          );
          projectedExpenses += delta;
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (expense_change): value is missing amountMinor or percent`,
          );
        }
        break;
      }

      case 'purchase': {
        const amt = parseAmountMinor(val.amountMinor);
        if (amt !== null) {
          projectedNetWorth -= BigInt(amt);
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (purchase): value is missing amountMinor`,
          );
        }
        break;
      }

      case 'new_debt': {
        const principal = parseAmountMinor(val.principalMinor);
        const payment = parseAmountMinor(val.monthlyPaymentMinor);
        if (principal !== null && payment !== null) {
          projectedNetWorth -= BigInt(principal);
          projectedExpenses += BigInt(payment);
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          const missing: string[] = [];
          if (principal === null) missing.push('principalMinor');
          if (payment === null) missing.push('monthlyPaymentMinor');
          riskByIndex.set(
            i,
            `assumptions[${i}] (new_debt): value is missing ${missing.join(', ')}`,
          );
        }
        break;
      }

      case 'extra_debt_payment': {
        const amt = parseAmountMinor(val.amountMinor);
        if (amt !== null) {
          projectedExpenses += BigInt(amt);
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (extra_debt_payment): value is missing amountMinor`,
          );
        }
        break;
      }

      case 'cancel_subscription': {
        const amt = parseAmountMinor(val.monthlyAmountMinor);
        if (amt !== null) {
          projectedExpenses -= BigInt(amt);
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (cancel_subscription): value is missing monthlyAmountMinor`,
          );
        }
        break;
      }

      case 'savings_contribution': {
        const amt = parseAmountMinor(val.monthlyAmountMinor);
        if (amt !== null) {
          projectedExpenses += BigInt(amt);
          // Net worth unchanged: money moved rather than left
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (savings_contribution): value is missing monthlyAmountMinor`,
          );
        }
        break;
      }

      case 'income_gap': {
        const months = parseMonths(val.months);
        if (months !== null) {
          const reduction = roundDivHalfAwayFromZero(
            baselineIncome * BigInt(months),
            12n,
          );
          projectedIncome -= reduction;
          isApplied[i] = true;
          appliedCount += 1;
        } else {
          riskByIndex.set(
            i,
            `assumptions[${i}] (income_gap): value is missing months`,
          );
        }
        break;
      }
    }
  }

  const risks: string[] = [];
  for (let i = 0; i < input.assumptions.length; i += 1) {
    const r = riskByIndex.get(i);
    if (r !== undefined) {
      risks.push(r);
    }
  }

  if (appliedCount === 0) {
    return {
      kind: 'ok',
      run: {
        status: 'failed',
        baseline,
        projected: { ...baseline },
        difference: {
          periodStart: baseline.periodStart,
          periodEnd: baseline.periodEnd,
          baseCurrency: baseline.baseCurrency,
          monthlyIncomeMinor: '0',
          monthlyExpensesMinor: '0',
          monthlySavingsCapacityMinor: '0',
          netWorthMinor: '0',
        },
        risks,
      },
    };
  }

  const projectedSavings = projectedIncome - projectedExpenses;
  const projected: ScenarioFigureSet = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseCurrency: input.baseCurrency,
    monthlyIncomeMinor: projectedIncome.toString(),
    monthlyExpensesMinor: projectedExpenses.toString(),
    monthlySavingsCapacityMinor: projectedSavings.toString(),
    netWorthMinor: projectedNetWorth.toString(),
  };

  const difference: ScenarioFigureSet = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseCurrency: input.baseCurrency,
    monthlyIncomeMinor: (projectedIncome - baselineIncome).toString(),
    monthlyExpensesMinor: (projectedExpenses - baselineExpenses).toString(),
    monthlySavingsCapacityMinor: (
      projectedSavings - baselineSavings
    ).toString(),
    netWorthMinor: (projectedNetWorth - baselineNetWorth).toString(),
  };

  return {
    kind: 'ok',
    run: {
      status: 'completed',
      baseline,
      projected,
      difference,
      risks,
    },
  };
}
