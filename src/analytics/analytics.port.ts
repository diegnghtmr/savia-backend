import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  FxRateUsed,
  SelectedFxRate,
} from '../platform/currency-conversion.js';

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

/**
 * The `granularity` query parameter of GET /v1/analytics/cash-flow, as the contract
 * authority declares it. Keep this separate from the shared implementation enum.
 */
export const CASH_FLOW_GRANULARITY = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
  YEAR: 'year',
} as const;

export type CashFlowGranularity =
  (typeof CASH_FLOW_GRANULARITY)[keyof typeof CASH_FLOW_GRANULARITY];

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
  NET_WORTH_HISTORY: 'net_worth_history',
  SPENDING_HEATMAP: 'spending_heatmap',
  SUBSCRIPTION_ANNUAL_COST: 'subscription_annual_cost',
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
  readonly fxRatesUsed?: readonly FxRateUsed[];
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
  readonly fxRatesUsed?: readonly FxRateUsed[];
}

export interface IncomeStability {
  readonly monthsCounted: number;
  readonly meanMonthlyIncomeMinor: bigint;
  readonly minMonthlyIncomeMinor: bigint;
  readonly maxMonthlyIncomeMinor: bigint;
  readonly coefficientOfVariationPercent: number | null;
  readonly medianMonthlyIncomeMinor: bigint;
  readonly trendPercent: number | null;
  readonly regularityPercent: number | null;
  readonly sourceConcentration: readonly IncomeSourceShare[];
}

export interface AnalyticsFlowRow extends ConvertedFlowRow {
  readonly payeeId?: string | null;
  readonly essential?: boolean;
  readonly extraordinary?: boolean;
  readonly recurrent?: boolean;
}

export interface SavingsComponents extends MonthlyCapacityPoint {
  readonly recurringIncomeMinor: bigint;
  readonly essentialExpensesMinor: bigint;
  readonly discretionaryExpensesMinor: bigint;
  readonly obligationsMinor: bigint;
  readonly currentSavingsMinor: bigint;
}

export interface BookedMoneyRow {
  readonly type: string;
  readonly amountMinor: bigint;
  readonly occurredAt: Date;
}

export interface HistoricPositionRow extends Record<string, unknown> {
  readonly date: string;
  readonly currency: string;
  readonly kind: 'account' | 'debt';
  readonly amountMinor: string;
}

export interface NetWorthPoint {
  readonly date: string;
  readonly assets: Money;
  readonly debts: Money;
  readonly netWorth: Money;
  readonly fxValuationChange: Money | null;
}

export interface IncomeSourceShare {
  readonly payeeId: string | null;
  readonly amount: Money;
  readonly sharePercent: number;
}

export interface SpendingHeatmapCell {
  readonly weekday: number;
  readonly dayOfMonth: number;
  readonly amount: Money;
  readonly count: number;
}

export interface AnnualSubscriptionItem {
  readonly subscriptionId: string;
  readonly payeeName: string;
  readonly currentAmount: Money;
  readonly previousAmount?: Money;
  readonly increasePercent?: number | null;
  readonly frequency: string;
  readonly nextExpectedDate?: string;
  readonly annualCost: Money | null;
}

export interface SubscriptionAnnualCost {
  readonly items: readonly AnnualSubscriptionItem[];
  readonly totalAnnualCost: Money;
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
  readonly principalPaidMinor?: bigint;
  readonly interestMinor: bigint;
  readonly feeMinor: bigint;
  readonly occurredAt: Date;
}

export interface DebtCostEvolutionPoint {
  readonly month: string;
  readonly principalPaidMinor: bigint;
  readonly paymentsMinor: bigint;
  readonly interestMinor: bigint;
  readonly feeMinor: bigint;
  readonly totalCostMinor: bigint;
}

export interface DebtCostEvolution {
  readonly series: readonly DebtCostEvolutionPoint[];
  readonly totalInterestMinor: bigint;
  readonly totalFeeMinor: bigint;
  readonly totalCostMinor: bigint;
  readonly debtOutlook: readonly DebtOutlook[];
}

export interface DebtOutlook {
  readonly debtId: string;
  readonly estimatedFutureCost: Money | null;
  readonly estimatedRemainingMonths: number | null;
}

export interface DebtTermsRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly outstandingBalanceMinor: string;
  readonly minimumPaymentMinor: string | null;
  readonly annualRate: string;
  readonly rateType: string;
  readonly frequency: string | null;
}

export interface ScheduledOutflowItem {
  readonly kind:
    | 'subscription'
    | 'debt_payment'
    | 'recurring_rule'
    | 'transaction'
    | 'income'
    | 'installment'
    | 'fund_contribution'
    | 'reminder';
  readonly refId: string;
  readonly label: string;
  readonly state: 'actual' | 'scheduled';
  readonly direction: 'inflow' | 'outflow' | 'none';
  readonly amountMinor: bigint | null;
}

export interface FinancialCalendarDay {
  readonly date: string;
  readonly expectedOutflowMinor: bigint;
  readonly expectedInflowMinor: bigint;
  readonly items: readonly ScheduledOutflowItem[];
}

export interface FinancialCalendar {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: readonly FinancialCalendarDay[];
  readonly totalExpectedOutflowMinor: bigint;
  readonly totalExpectedInflowMinor: bigint;
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

export const ANALYTICS_FILTERS = [
  'accountIds',
  'categoryIds',
  'tagIds',
  'payeeIds',
  'memberIds',
] as const;

export type AnalyticsFilter = (typeof ANALYTICS_FILTERS)[number];
export type AnalyticsFilters = Partial<
  Record<AnalyticsFilter, readonly string[]>
>;

export interface AnalyticsSelection {
  readonly presentationCurrency?: string;
  readonly filters?: AnalyticsFilters;
}

export interface CashFlowAnalyticsQuery extends AnalyticsSelection {
  readonly workspaceId: string;
  readonly from: string;
  readonly to: string;
  readonly granularity: CashFlowGranularity;
}

export interface AdvancedAnalyticsQuery extends AnalyticsSelection {
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

export type AdvancedMetricData = {
  [ADVANCED_METRIC.RECURRING_VS_VARIABLE]: RecurringVsVariable;
  [ADVANCED_METRIC.FINANCIAL_CALENDAR]: FinancialCalendar;
  [ADVANCED_METRIC.WEEKDAY_HEATMAP]: {
    readonly series: readonly WeekdayHeatmapPoint[];
  };
  [ADVANCED_METRIC.BALANCE_PROJECTION]: BalanceProjection;
  [ADVANCED_METRIC.QUARTERLY_AVERAGE_COMPARISON]: {
    readonly series: readonly QuarterlyAveragePoint[];
  };
  [ADVANCED_METRIC.SUBSCRIPTION_PRICE_INCREASES]: SubscriptionPriceIncreases;
  [ADVANCED_METRIC.INCOME_STABILITY]: IncomeStability;
  [ADVANCED_METRIC.MONTHLY_SAVINGS_CAPACITY]: {
    readonly series: readonly SavingsComponents[];
  };
  [ADVANCED_METRIC.DEBT_COST_EVOLUTION]: DebtCostEvolution;
  [ADVANCED_METRIC.NET_WORTH_HISTORY]: {
    readonly series: readonly NetWorthPoint[];
  };
  [ADVANCED_METRIC.SPENDING_HEATMAP]: {
    readonly cells: readonly SpendingHeatmapCell[];
  };
  [ADVANCED_METRIC.SUBSCRIPTION_ANNUAL_COST]: SubscriptionAnnualCost;
};

type JsonAmounts<T> = T extends bigint
  ? string
  : T extends object
    ? {
        [K in keyof T]: JsonAmounts<T[K]>;
      }
    : T;

export type AdvancedAnalytics<M extends AdvancedMetric = AdvancedMetric> = {
  [K in M]: {
    readonly metric: K;
    readonly generatedAt: string;
    readonly currency: string;
    readonly assumptions: readonly string[];
    readonly missingData: readonly string[];
    readonly data: JsonAmounts<AdvancedMetricData[K]>;
    readonly explanation: string | null;
    readonly fxRatesUsed?: readonly FxRateUsed[];
  };
}[M];

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
  readonly payeeId?: string | null;
  readonly essential?: boolean;
  readonly extraordinary?: boolean;
  readonly recurrent?: boolean;
  readonly description?: string | null;
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
  readonly id?: string;
  readonly payeeName?: string;
  readonly previousAmountMinor?: string | null;
  readonly previousCurrency?: string | null;
  readonly nextExpectedDate?: string | null;
  readonly recurringRuleId?: string | null;
  readonly observationId?: string | null;
  readonly currentAmountMinor: string;
  readonly currentCurrency: string;
  readonly frequency: string;
}

export interface DebtPaymentCostRow extends Record<string, unknown> {
  readonly principalPaidMinor?: string;
  readonly interestMinor: string;
  readonly feeMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
}

export interface ScheduledOutflowRow extends Record<string, unknown> {
  readonly kind: ScheduledOutflowItem['kind'];
  readonly state?: ScheduledOutflowItem['state'];
  readonly direction?: ScheduledOutflowItem['direction'];
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
    accountIds?: readonly string[],
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
    filters?: AnalyticsFilters,
    includeOtherBookings?: boolean,
    classifyRecurring?: boolean,
  ): Promise<readonly TransactionFlowRow[]>;

  hasRecurringHistory(client: TransactionClient): Promise<boolean>;

  readHistoricPositions(
    client: TransactionClient,
    workspaceId: string,
    dates: readonly string[],
    asOf: Date,
    accountIds?: readonly string[],
  ): Promise<readonly HistoricPositionRow[]>;

  readDebtTerms(
    client: TransactionClient,
    workspaceId: string,
    asOf: Date,
  ): Promise<readonly DebtTermsRow[]>;

  readSubscriptionsWithPreviousAmount(
    client: TransactionClient,
    workspaceId: string,
    filters?: AnalyticsFilters,
  ): Promise<readonly SubscriptionPriceRow[]>;

  readActiveSubscriptions(
    client: TransactionClient,
    workspaceId: string,
    filters?: AnalyticsFilters,
  ): Promise<readonly ActiveSubscriptionRow[]>;

  readDebtPaymentCostsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    filters?: AnalyticsFilters,
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
    historical?: boolean,
  ): Promise<SelectedFxRate | undefined>;

  readScheduledOutflows(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    filters?: AnalyticsFilters,
  ): Promise<readonly ScheduledOutflowRow[]>;

  readActiveDebtsWithoutScheduledAmount(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<number>;
}
