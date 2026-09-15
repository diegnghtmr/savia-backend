import { multiplyMinorByRate } from '../platform/currency-conversion.js';
import {
  buildMonthlySavingsCapacity,
  GRANULARITY,
  truncateToBucketStart,
  type ConvertedFlowRow,
} from '../platform/monthly-capacity.js';
import { PROBLEM_TYPES } from '../platform/problem-details.js';
import {
  computeForecast,
  type AppliedScenarioRunData,
} from './forecast-engine.js';
import type {
  AccountNativeBalanceRow,
  ForecastConfidence,
  ForecastPoint,
  TransactionFlowRow,
} from './forecast.port.js';

export class ForecastMissingRateError extends Error {
  public readonly isDomainError = true;
  public readonly type = PROBLEM_TYPES.UNPROCESSABLE;
  public readonly title = 'Missing exchange rate';
  public readonly status = 422;
  public readonly code = 'unprocessable';

  public constructor(
    public readonly fromCurrency: string,
    public readonly toCurrency: string,
  ) {
    super(`Missing exchange rate from ${fromCurrency} to ${toCurrency}`);
    this.name = 'ForecastMissingRateError';
  }
}

export interface ForecastComputationInput {
  readonly baseCurrency: string;
  readonly horizonDays: number;
  readonly asOf: Date;
  readonly includeScenarios: boolean;
  readonly closedAccountAssumptions: readonly string[];
  readonly accountBalances: readonly AccountNativeBalanceRow[];
  readonly flowRows: readonly TransactionFlowRow[];
  readonly rates: ReadonlyMap<string, string>;
  readonly appliedScenarioRun: AppliedScenarioRunData | null;
}

export interface ForecastComputationResult {
  readonly confidence: ForecastConfidence;
  readonly method: string;
  readonly assumptions: readonly string[];
  readonly series: readonly ForecastPoint[];
}

function requireRate(
  rates: ReadonlyMap<string, string>,
  fromCurrency: string,
  toCurrency: string,
): string {
  const rate = rates.get(`${fromCurrency}:${toCurrency}`);
  if (!rate) {
    throw new ForecastMissingRateError(fromCurrency, toCurrency);
  }
  return rate;
}

export function computeBalanceForecast(
  input: ForecastComputationInput,
): ForecastComputationResult {
  let openingBalanceMinor = 0n;
  for (const acct of input.accountBalances) {
    if (acct.currency === input.baseCurrency) {
      openingBalanceMinor += BigInt(acct.nativeBalanceMinor);
    } else {
      const rate = requireRate(input.rates, acct.currency, input.baseCurrency);
      openingBalanceMinor += BigInt(
        multiplyMinorByRate(acct.nativeBalanceMinor, rate),
      );
    }
  }

  const convertedFlowRows: ConvertedFlowRow[] = [];
  for (const row of input.flowRows) {
    let amountMinor: bigint;
    if (row.currency === input.baseCurrency) {
      amountMinor = BigInt(row.amountMinor);
    } else {
      const rate = requireRate(input.rates, row.currency, input.baseCurrency);
      amountMinor = BigInt(multiplyMinorByRate(row.amountMinor, rate));
    }
    convertedFlowRows.push({
      type: row.type,
      amountMinor,
      occurredAt: new Date(row.occurredAt),
    });
  }

  const periodEnd = input.asOf.toISOString().slice(0, 10);
  const nowYear = input.asOf.getUTCFullYear();
  const nowMonth = input.asOf.getUTCMonth();
  const startMonthDate = new Date(Date.UTC(nowYear, nowMonth - 11, 1));
  const periodStart = startMonthDate.toISOString().slice(0, 10);

  const monthsWithRows = new Set<string>();
  for (const row of convertedFlowRows) {
    monthsWithRows.add(
      truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH),
    );
  }
  const monthsOfHistoryAvailable = monthsWithRows.size;

  const buckets = buildMonthlySavingsCapacity(
    periodStart,
    periodEnd,
    convertedFlowRows,
  );

  let monthlySavingsCapacities: bigint[] = [];
  if (monthsOfHistoryAvailable > 0) {
    const firstIdx = buckets.findIndex((b) => monthsWithRows.has(b.month));
    if (firstIdx !== -1) {
      monthlySavingsCapacities = buckets
        .slice(firstIdx)
        .map((b) => b.savingsCapacityMinor);
    }
  }

  const engineResult = computeForecast({
    openingBalanceMinor,
    baseCurrency: input.baseCurrency,
    horizonDays: input.horizonDays,
    today: input.asOf,
    monthlySavingsCapacities,
    monthsOfHistoryAvailable,
    includeScenarios: input.includeScenarios,
    appliedScenarioRun: input.appliedScenarioRun,
  });

  return {
    confidence: engineResult.confidence,
    method: engineResult.method,
    assumptions: [
      ...input.closedAccountAssumptions,
      ...engineResult.assumptions,
    ],
    series: engineResult.series,
  };
}
