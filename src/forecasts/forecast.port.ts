import type { TransactionClient } from '../platform/pg-transaction.js';
import type { Job } from '../jobs/job.port.js';

export const FORECASTS_PORT = Symbol('ForecastsPort');

export const FORECAST_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
] as const;
export type ForecastStatus = (typeof FORECAST_STATUSES)[number];

export const FORECAST_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type ForecastConfidence = (typeof FORECAST_CONFIDENCES)[number];

export const FORECAST_METHOD =
  'mean-monthly-flow-with-population-stddev-bounds';

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface ForecastPoint {
  readonly date: string;
  readonly expected: Money;
  readonly lowerBound: Money;
  readonly upperBound: Money;
}

export interface ForecastRequest {
  readonly horizonDays: number;
  readonly accountIds?: readonly string[];
  readonly includeScenarios: boolean;
}

export interface Forecast {
  readonly id: string;
  readonly status: ForecastStatus;
  readonly generatedAt: string;
  readonly confidence: ForecastConfidence;
  readonly assumptions: readonly string[];
  readonly series: readonly ForecastPoint[];
  readonly method: string;
}

export const FORECAST_OUTCOMES = {
  ACCEPTED: 'accepted',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  UNPROCESSABLE: 'unprocessable',
  MISSING_RATE: 'missing_rate',
  NOT_FOUND: 'not_found',
  OK: 'ok',
} as const;

export type ForecastCreateOutcome =
  | {
      readonly kind: typeof FORECAST_OUTCOMES.ACCEPTED;
      readonly job: Job;
    }
  | {
      readonly kind: typeof FORECAST_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag?: string | null;
      readonly body: unknown;
    }
  | { readonly kind: typeof FORECAST_OUTCOMES.CONFLICT }
  | { readonly kind: typeof FORECAST_OUTCOMES.FORBIDDEN }
  | {
      readonly kind: typeof FORECAST_OUTCOMES.UNPROCESSABLE;
      readonly violations: readonly { field: string; message: string }[];
    }
  | {
      readonly kind: typeof FORECAST_OUTCOMES.MISSING_RATE;
      readonly fromCurrency: string;
      readonly toCurrency: string;
    };

export type ForecastGetOutcome =
  | {
      readonly kind: typeof FORECAST_OUTCOMES.OK;
      readonly forecast: Forecast;
    }
  | { readonly kind: typeof FORECAST_OUTCOMES.NOT_FOUND }
  | { readonly kind: typeof FORECAST_OUTCOMES.FORBIDDEN };

export interface AccountNativeBalanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly nativeBalanceMinor: string;
}

export interface AccountExistenceRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
}

export interface TransactionFlowRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: 'income' | 'expense' | 'refund';
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
}

export interface ScenarioRunRowData extends Record<string, unknown> {
  readonly id: string;
  readonly monthlySavingsCapacityMinor: string;
}

export interface CreateForecastRecord {
  readonly id: string;
  readonly jobId: string;
  readonly status: ForecastStatus;
  readonly confidence: ForecastConfidence;
  readonly method: string;
  readonly horizonDays: number;
  readonly assumptions: readonly string[];
  readonly series: readonly ForecastPoint[];
  readonly generatedAt: Date;
}

export interface ForecastStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  readWorkspaceBaseCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  findForecastById(
    client: TransactionClient,
    workspaceId: string,
    forecastId: string,
  ): Promise<Forecast | undefined>;

  checkAccountsExist(
    client: TransactionClient,
    workspaceId: string,
    accountIds: readonly string[],
  ): Promise<readonly AccountExistenceRow[]>;

  readAccountNativeBalances(
    client: TransactionClient,
    workspaceId: string,
    accountIds?: readonly string[],
  ): Promise<readonly AccountNativeBalanceRow[]>;

  readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly TransactionFlowRow[]>;

  findExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    asOf?: Date | null,
  ): Promise<string | undefined>;

  findMostRecentCompletedScenarioRun(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<ScenarioRunRowData | undefined>;

  createForecast(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    data: CreateForecastRecord,
  ): Promise<void>;
}

export interface ForecastsPort {
  createBalanceForecast(
    subject: string,
    workspaceId: string,
    command: ForecastRequest,
    key: string,
  ): Promise<ForecastCreateOutcome>;

  getForecast(
    subject: string,
    workspaceId: string,
    forecastId: string,
  ): Promise<ForecastGetOutcome>;
}
