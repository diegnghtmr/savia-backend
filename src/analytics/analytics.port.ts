import type { TransactionClient } from '../platform/pg-transaction.js';

export const ANALYTICS_PORT = Symbol('AnalyticsPort');

export const GRANULARITY = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
} as const;
export type Granularity = (typeof GRANULARITY)[keyof typeof GRANULARITY];

export const ANALYTICS_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  BAD_REQUEST: 'bad_request',
  MISSING_RATE: 'missing_rate',
} as const;
export type AnalyticsOutcomeKind =
  (typeof ANALYTICS_OUTCOMES)[keyof typeof ANALYTICS_OUTCOMES];

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface AnalyticsSummary {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly baseCurrency: string;
  readonly netWorth: Money;
  readonly assets: Money;
  readonly debts: Money;
  readonly income: Money;
  readonly expenses: Money;
  readonly savingsCapacity: Money;
  readonly budgetUtilizationPercent?: number;
}

export interface TimeSeriesPoint {
  readonly period: string;
  readonly value: Money;
  readonly secondaryValue: Money;
}

export interface CategoryBreakdownItem {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly amount: Money;
  readonly percentage: number;
}

export interface CashFlowAnalytics {
  readonly series: readonly TimeSeriesPoint[];
  readonly categories: readonly CategoryBreakdownItem[];
}

export interface AnalyticsSummaryQuery {
  readonly workspaceId: string;
  readonly from: string;
  readonly to: string;
  readonly presentationCurrency?: string;
}

export interface CashFlowAnalyticsQuery {
  readonly workspaceId: string;
  readonly from: string;
  readonly to: string;
  readonly granularity: Granularity;
}

export interface AnalyticsForbiddenOutcome {
  readonly kind: typeof ANALYTICS_OUTCOMES.FORBIDDEN;
}

export interface AnalyticsMissingRateOutcome {
  readonly kind: typeof ANALYTICS_OUTCOMES.MISSING_RATE;
  readonly fromCurrency: string;
  readonly toCurrency: string;
}

export interface AnalyticsSummaryOkOutcome {
  readonly kind: typeof ANALYTICS_OUTCOMES.OK;
  readonly summary: AnalyticsSummary;
}

export type AnalyticsSummaryOutcome =
  | AnalyticsSummaryOkOutcome
  | AnalyticsForbiddenOutcome
  | AnalyticsMissingRateOutcome;

export interface CashFlowAnalyticsOkOutcome {
  readonly kind: typeof ANALYTICS_OUTCOMES.OK;
  readonly analytics: CashFlowAnalytics;
}

export type CashFlowAnalyticsOutcome =
  | CashFlowAnalyticsOkOutcome
  | AnalyticsForbiddenOutcome
  | AnalyticsMissingRateOutcome;

export interface AnalyticsPort {
  getSummary(
    subject: string,
    query: AnalyticsSummaryQuery,
  ): Promise<AnalyticsSummaryOutcome>;

  getCashFlow(
    subject: string,
    query: CashFlowAnalyticsQuery,
  ): Promise<CashFlowAnalyticsOutcome>;
}

export interface AccountNativeBalanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly nativeBalanceMinor: string;
}

export interface DebtOutstandingBalanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly outstandingBalanceMinor: string;
}

export interface TransactionFlowRow extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
}

export interface BudgetAllocationRow extends Record<string, unknown> {
  readonly currency: string;
  readonly plannedMinor: string;
}

export interface BudgetSpendRow extends Record<string, unknown> {
  readonly amountMinor: string;
  readonly postingCurrency: string;
  readonly occurredAt: Date;
}

export interface AnalyticsStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  readWorkspaceBaseCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;

  readAccountNativeBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly AccountNativeBalanceRow[]>;

  readDebtOutstandingBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly DebtOutstandingBalanceRow[]>;

  readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly TransactionFlowRow[]>;

  readOverlappingBudgetAllocations(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly BudgetAllocationRow[]>;

  readOverlappingBudgetSpend(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly BudgetSpendRow[]>;

  findExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    asOf?: Date | null,
  ): Promise<string | undefined>;
}
