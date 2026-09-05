import type { TransactionClient } from '../platform/pg-transaction.js';

export const ANALYTICS_PORT = Symbol('AnalyticsPort');

import {
  GRANULARITY,
  type Granularity,
  type ConvertedFlowRow,
  type MonthlyCapacityPoint,
} from '../platform/monthly-capacity.js';

export {
  GRANULARITY,
  type Granularity,
  type ConvertedFlowRow,
  type MonthlyCapacityPoint,
};

export const ADVANCED_METRIC = {
  RECURRING_VS_VARIABLE: 'recurring_vs_variable',
  FINANCIAL_CALENDAR: 'financial_calendar',
  WEEKDAY_HEATMAP: 'weekday_heatmap',
  BALANCE_PROJECTION: 'balance_projection',
  QUARTERLY_AVERAGE_COMPARISON: 'quarterly_average_comparison',
  SUBSCRIPTION_PRICE_INCREASES: 'subscription_price_increases',
  INCOME_STABILITY: 'income_stability',
  MONTHLY_SAVINGS_CAPACITY: 'monthly_savings_capacity',
  DEBT_COST_EVOLUTION: 'debt_cost_evolution',
} as const;
export type AdvancedMetric =
  (typeof ADVANCED_METRIC)[keyof typeof ADVANCED_METRIC];

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

export interface IncomeStability {
  readonly monthsCounted: number;
  readonly meanMonthlyIncomeMinor: bigint;
  readonly minMonthlyIncomeMinor: bigint;
  readonly maxMonthlyIncomeMinor: bigint;
  readonly coefficientOfVariationPercent: number | null;
}

export interface QuarterlyAveragePoint {
  readonly quarter: string;
  readonly monthsCounted: number;
  readonly averageMonthlyIncomeMinor: bigint;
  readonly averageMonthlyExpensesMinor: bigint;
  readonly averageMonthlySavingsCapacityMinor: bigint;
  readonly savingsCapacityDeltaPercentVsPreviousQuarter: number | null;
}

export interface WeekdayHeatmapPoint {
  readonly weekday: number;
  readonly transactionCount: number;
  readonly totalMinor: bigint;
}

export interface SubscriptionPriceIncreaseItem {
  readonly subscriptionId: string;
  readonly payeeName: string;
  readonly previousAmount: Money;
  readonly currentAmount: Money;
  readonly increasePercent: number;
}

export interface SubscriptionPriceIncreases {
  readonly items: readonly SubscriptionPriceIncreaseItem[];
  readonly consideredCount: number;
  readonly decreasedOrUnchangedCount: number;
  readonly excludedForCurrencyMismatch: number;
  readonly excludedForZeroPrevious: number;
}

export interface ConvertedSubscriptionRow {
  readonly amountMinor: bigint;
  readonly frequency: string;
}

export interface RecurringVsVariable {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly committedMinor: bigint;
  readonly variableMinor: bigint;
  readonly totalExpensesMinor: bigint;
  readonly committedPercent: number | null;
  readonly consideredSubscriptionCount: number;
  readonly unclassifiedSubscriptionCount: number;
}

export interface ConvertedDebtCostRow {
  readonly interestMinor: bigint;
  readonly feeMinor: bigint;
  readonly occurredAt: Date;
}

export interface DebtCostEvolutionPoint {
  readonly month: string;
  readonly interestMinor: bigint;
  readonly feeMinor: bigint;
  readonly totalCostMinor: bigint;
}

export interface DebtCostEvolution {
  readonly series: readonly DebtCostEvolutionPoint[];
  readonly totalInterestMinor: bigint;
  readonly totalFeeMinor: bigint;
  readonly totalCostMinor: bigint;
}

export interface ScheduledOutflowItem {
  readonly kind: 'subscription' | 'debt_payment' | 'recurring_rule';
  readonly refId: string;
  readonly label: string;
  readonly amountMinor: bigint;
}

export interface FinancialCalendarDay {
  readonly date: string;
  readonly expectedOutflowMinor: bigint;
  readonly items: readonly ScheduledOutflowItem[];
}

export interface FinancialCalendar {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: readonly FinancialCalendarDay[];
  readonly totalExpectedOutflowMinor: bigint;
  readonly debtsWithoutScheduledAmount: number;
  readonly recurringRulesWithUnreadableTemplate: number;
}

export interface BalanceProjectionPoint {
  readonly month: string;
  readonly expectedInflowMinor: bigint;
  readonly expectedOutflowMinor: bigint;
  readonly projectedBalanceMinor: bigint;
}

export interface BalanceProjection {
  readonly openingBalanceMinor: bigint;
  readonly basisMonths: number;
  readonly meanMonthlyIncomeMinor: bigint;
  readonly meanMonthlyExpensesMinor: bigint;
  readonly months: readonly BalanceProjectionPoint[];
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

export interface AdvancedAnalyticsQuery {
  readonly workspaceId: string;
  readonly metric: AdvancedMetric;
  readonly from: string;
  readonly to: string;
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

export interface AdvancedAnalytics {
  readonly metric: AdvancedMetric;
  readonly generatedAt: string;
  readonly data: Record<string, unknown>;
  readonly explanation: string | null;
}

export interface AdvancedAnalyticsOkOutcome {
  readonly kind: typeof ANALYTICS_OUTCOMES.OK;
  readonly analytics: AdvancedAnalytics;
}

export type AdvancedAnalyticsOutcome =
  | AdvancedAnalyticsOkOutcome
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

  getAdvancedAnalytics(
    subject: string,
    query: AdvancedAnalyticsQuery,
  ): Promise<AdvancedAnalyticsOutcome>;
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

export interface SubscriptionPriceRow extends Record<string, unknown> {
  readonly id: string;
  readonly payeeName: string;
  readonly currentAmountMinor: string;
  readonly currentCurrency: string;
  readonly previousAmountMinor: string;
  readonly previousCurrency: string;
}

export interface ActiveSubscriptionRow extends Record<string, unknown> {
  readonly currentAmountMinor: string;
  readonly currentCurrency: string;
  readonly frequency: string;
}

export interface DebtPaymentCostRow extends Record<string, unknown> {
  readonly interestMinor: string;
  readonly feeMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
}

export interface ScheduledOutflowRow extends Record<string, unknown> {
  readonly kind: 'subscription' | 'debt_payment' | 'recurring_rule';
  readonly refId: string;
  readonly label: string;
  readonly amountMinor?: string | bigint | null;
  readonly currency?: string | null;
  readonly scheduledDate?: string | null;
  readonly scheduledAt?: Date | null;
  readonly template?: {
    readonly type?: string | null;
    readonly amount?: {
      readonly amountMinor?: string;
      readonly currency?: string;
    } | null;
  } | null;
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

  readSubscriptionsWithPreviousAmount(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly SubscriptionPriceRow[]>;

  readActiveSubscriptions(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly ActiveSubscriptionRow[]>;

  readDebtPaymentCostsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly DebtPaymentCostRow[]>;

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

  readScheduledOutflows(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly ScheduledOutflowRow[]>;

  readActiveDebtsWithoutScheduledAmount(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<number>;
}
