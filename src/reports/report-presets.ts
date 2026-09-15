import type {
  ReportDimension,
  ReportMeasure,
  ReportVisualization,
} from './report.port.js';

export const REPORT_PRESET = {
  MONTHLY_SUMMARY: 'monthly_summary',
  CASH_FLOW: 'cash_flow',
  EXPENSES: 'expenses',
  INCOME: 'income',
  BUDGET: 'budget',
  NET_WORTH: 'net_worth',
  DEBTS: 'debts',
  FUNDS: 'funds',
  FAMILY_WORKSPACE: 'family_workspace',
  MULTI_CURRENCY: 'multi_currency',
  FORECAST: 'forecast',
  PERIOD_COMPARISON: 'period_comparison',
} as const;
export type ReportPreset = (typeof REPORT_PRESET)[keyof typeof REPORT_PRESET];

export interface ReportPresetDefinition {
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly visualization: ReportVisualization;
  readonly typeFilter?: string;
}

export const REPORT_PRESETS: Readonly<
  Record<ReportPreset, ReportPresetDefinition>
> = {
  monthly_summary: {
    dimensions: ['month'],
    measures: ['sum', 'count', 'average'],
    visualization: 'table',
  },
  cash_flow: {
    dimensions: ['month', 'transaction_type'],
    measures: ['converted_value', 'balance'],
    visualization: 'line',
  },
  expenses: {
    dimensions: ['category'],
    measures: ['converted_value', 'percentage'],
    visualization: 'donut',
    typeFilter: 'expense',
  },
  income: {
    dimensions: ['category'],
    measures: ['converted_value', 'percentage'],
    visualization: 'donut',
    typeFilter: 'income',
  },
  budget: {
    dimensions: ['month', 'category'],
    measures: ['budget', 'converted_value', 'variance'],
    visualization: 'table',
    typeFilter: 'expense',
  },
  net_worth: {
    dimensions: ['month'],
    measures: ['balance'],
    visualization: 'area',
  },
  debts: {
    dimensions: ['month'],
    measures: ['converted_value', 'balance'],
    visualization: 'line',
    typeFilter: 'debt_payment',
  },
  funds: {
    dimensions: ['month'],
    measures: ['converted_value', 'balance'],
    visualization: 'line',
    typeFilter: 'fund_contribution',
  },
  family_workspace: {
    dimensions: ['member', 'month'],
    measures: ['converted_value', 'percentage'],
    visualization: 'bar',
  },
  multi_currency: {
    dimensions: ['currency'],
    measures: ['sum', 'converted_value', 'percentage'],
    visualization: 'table',
  },
  forecast: {
    dimensions: ['month'],
    measures: ['converted_value', 'moving_average'],
    visualization: 'line',
  },
  period_comparison: {
    dimensions: ['month'],
    measures: ['converted_value', 'variation'],
    visualization: 'bar',
  },
};

export const REPORT_PRESETS_LIST = Object.freeze(
  Object.keys(REPORT_PRESETS) as ReportPreset[],
);
