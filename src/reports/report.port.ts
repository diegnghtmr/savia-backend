import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const REPORTS_PORT = Symbol('ReportsPort');

export const REPORT_DIMENSION = {
  DATE: 'date',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
  YEAR: 'year',
  ACCOUNT: 'account',
  ACCOUNT_TYPE: 'account_type',
  CATEGORY: 'category',
  TAG: 'tag',
  PAYEE: 'payee',
  CURRENCY: 'currency',
  MEMBER: 'member',
  STATUS: 'status',
  TRANSACTION_TYPE: 'transaction_type',
  VARIABILITY: 'variability',
} as const;

export type ReportDimension =
  (typeof REPORT_DIMENSION)[keyof typeof REPORT_DIMENSION];

export const REPORT_DIMENSIONS: readonly ReportDimension[] = Object.freeze(
  Object.values(REPORT_DIMENSION),
);

export const REPORT_MEASURE = {
  SUM: 'sum',
  COUNT: 'count',
  AVERAGE: 'average',
  MINIMUM: 'minimum',
  MAXIMUM: 'maximum',
  VARIATION: 'variation',
  PERCENTAGE: 'percentage',
  BALANCE: 'balance',
  BUDGET: 'budget',
  VARIANCE: 'variance',
  MOVING_AVERAGE: 'moving_average',
  CONVERTED_VALUE: 'converted_value',
} as const;

export type ReportMeasure =
  (typeof REPORT_MEASURE)[keyof typeof REPORT_MEASURE];

export const REPORT_MEASURES: readonly ReportMeasure[] = Object.freeze(
  Object.values(REPORT_MEASURE),
);

export const REPORT_VISUALIZATION = {
  TABLE: 'table',
  KPI: 'kpi',
  BAR: 'bar',
  LINE: 'line',
  AREA: 'area',
  DONUT: 'donut',
  HEATMAP: 'heatmap',
  CALENDAR: 'calendar',
  PIVOT: 'pivot',
} as const;

export type ReportVisualization =
  (typeof REPORT_VISUALIZATION)[keyof typeof REPORT_VISUALIZATION];

export const REPORT_VISUALIZATIONS: readonly ReportVisualization[] =
  Object.freeze(Object.values(REPORT_VISUALIZATION));

export interface ReportDefinition {
  readonly id: string;
  readonly name: string;
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly visualization: ReportVisualization;
  readonly filters: Record<string, unknown>;
  readonly version: number;
}

export interface CreateReportDefinitionRequest {
  readonly name: string;
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly visualization: ReportVisualization;
  readonly filters?: Record<string, unknown>;
}

export interface ReportListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface ReportItem {
  readonly reportDefinition: ReportDefinition;
  readonly cursorAt: string;
}

export interface ReportPage {
  readonly items: readonly ReportDefinition[];
  readonly pageInfo: PageInfo;
}

export const REPORT_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  OK: 'ok',
} as const;

export type ReportCreateOutcome =
  | {
      readonly kind: typeof REPORT_OUTCOMES.CREATED;
      readonly reportDefinition: ReportDefinition;
    }
  | {
      readonly kind: typeof REPORT_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag?: string | null;
      readonly body: unknown;
    }
  | { readonly kind: typeof REPORT_OUTCOMES.CONFLICT }
  | { readonly kind: typeof REPORT_OUTCOMES.FORBIDDEN };

export type ReportListOutcome =
  | { readonly kind: 'ok'; readonly page: ReportPage }
  | { readonly kind: typeof REPORT_OUTCOMES.FORBIDDEN };

export interface ReportStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createReportDefinition(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateReportDefinitionRequest,
  ): Promise<ReportDefinition>;
  listReportDefinitions(
    client: TransactionClient,
    query: ReportListQuery,
    limit: number,
  ): Promise<readonly ReportItem[]>;
}

export interface ReportsPort {
  createReportDefinition(
    subject: string,
    workspaceId: string,
    command: CreateReportDefinitionRequest,
    key: string,
  ): Promise<ReportCreateOutcome>;
  listReportDefinitions(
    subject: string,
    query: ReportListQuery,
  ): Promise<ReportListOutcome>;
}
