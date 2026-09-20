import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
export interface ReportSourceRow {
  readonly transactionId: string;
  readonly occurredAt: Date;
  readonly type:
    | 'income'
    | 'expense'
    | 'refund'
    | 'adjustment'
    | 'debt_payment'
    | 'fund_contribution';
  readonly status: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly convertedMinor: bigint;
  readonly accountId: string;
  readonly accountType: string;
  readonly categoryId: string | null;
  readonly tags: readonly string[];
  readonly payee: string | null;
  readonly memberId: string;
}

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

export const REPORT_RUN_FORMAT = {
  JSON: 'json',
  CSV: 'csv',
  PDF: 'pdf',
} as const;
export type ReportRunFormat =
  (typeof REPORT_RUN_FORMAT)[keyof typeof REPORT_RUN_FORMAT];

export const REPORT_RUN_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type ReportRunStatus =
  (typeof REPORT_RUN_STATUS)[keyof typeof REPORT_RUN_STATUS];

export interface CreateReportRunRequest {
  readonly definitionId?: string | null;
  readonly preset?: string | null;
  readonly format: ReportRunFormat;
  readonly filters: Record<string, unknown>;
}

export interface ReportRun {
  readonly id: string;
  readonly definitionId: string | null;
  readonly preset: string | null;
  readonly status: ReportRunStatus;
  readonly format: ReportRunFormat;
  readonly snapshotId: string | null;
  readonly downloadUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
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
  readReportDefinition?(
    client: TransactionClient,
    workspaceId: string,
    definitionId: string,
  ): Promise<ReportDefinition | undefined>;
  readWorkspaceBaseCurrency?(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  readReportSourceRows?(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    asOf: Date,
    typeFilter?: string,
    callerTypeFilter?: string,
  ): Promise<readonly ReportSourceRow[]>;
  readBudgetedMinorByBucket?(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    dimensions: readonly ReportDimension[],
  ): Promise<ReadonlyMap<string, bigint>>;
  insertQueuedReportRun?(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    data: CreateQueuedReportRunRecord,
  ): Promise<ReportRun>;
  beginProcessingReportRun?(
    client: TransactionClient,
    workspaceId: string,
    reportRunId: string,
    jobId: string,
  ): Promise<void>;
  completeProcessingReportRun?(
    client: TransactionClient,
    workspaceId: string,
    reportRunId: string,
    jobId: string,
    data: CompleteProcessingReportRunRecord,
  ): Promise<ReportRun>;
  findReportRun?(
    client: TransactionClient,
    workspaceId: string,
    reportRunId: string,
  ): Promise<ReportRun | undefined>;
}

export interface CreateQueuedReportRunRecord {
  readonly id: string;
  readonly definitionId: string | null;
  readonly preset: string | null;
  readonly format: ReportRunFormat;
  readonly filters: Record<string, unknown>;
  readonly snapshotId: string;
  readonly jobId: string;
}

export interface CompleteProcessingReportRunRecord {
  readonly downloadUrl: string;
  readonly expiresAt: Date;
  readonly completedAt: Date;
}

/**
 * Maximum rows allowed in a PDF report render. Beyond this, the grid must be
 * exported as json/csv. This is a permanent-failure condition.
 */
export const REPORT_PDF_ROW_CAP = 2_000;

/**
 * Maximum source rows allowed in a synchronous report run to prevent heap exhaustion
 * and event-loop monopolization. 50,000 rows provides rich analytics coverage for
 * multi-year workspace history while keeping memory and processing within safe request bounds.
 */
export const REPORT_SOURCE_ROW_CAP = 50_000;

/**
 * Maximum total grid cells (rows * measures) allowed in a generated report.
 * Guards against fan-out explosion (e.g. multi-tag expansion) while allowing large tabular outputs.
 */
export const REPORT_GRID_CELL_CAP = 100_000;

/**
 * Maximum string length allowed for an individual rendered cell or dimension value.
 * Prevents single pathological strings (e.g. 100k-char payee or note) from dominating renderers.
 */
export const REPORT_MAX_CELL_STRING_LENGTH = 4096;

let activeSourceRowCap = REPORT_SOURCE_ROW_CAP;
let activeGridCellCap = REPORT_GRID_CELL_CAP;
let activeMaxCellStringLength = REPORT_MAX_CELL_STRING_LENGTH;

export function getReportSourceRowCap(): number {
  if (process.env.REPORT_SOURCE_ROW_CAP !== undefined) {
    const parsed = Number(process.env.REPORT_SOURCE_ROW_CAP);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return activeSourceRowCap;
}

export function setReportSourceRowCap(cap: number): void {
  activeSourceRowCap = cap;
}

export function getReportGridCellCap(): number {
  if (process.env.REPORT_GRID_CELL_CAP !== undefined) {
    const parsed = Number(process.env.REPORT_GRID_CELL_CAP);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return activeGridCellCap;
}

export function setReportGridCellCap(cap: number): void {
  activeGridCellCap = cap;
}

export function getReportMaxCellStringLength(): number {
  if (process.env.REPORT_MAX_CELL_STRING_LENGTH !== undefined) {
    const parsed = Number(process.env.REPORT_MAX_CELL_STRING_LENGTH);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return activeMaxCellStringLength;
}

export function setReportMaxCellStringLength(max: number): void {
  activeMaxCellStringLength = max;
}

export class ReportRowCapExceededError extends Error {
  public readonly isDomainError = true;

  public constructor(public readonly cap: number) {
    super(
      `Report matched more source rows than the limit of ${cap} allowed for synchronous execution. Please specify a narrower period or additional filters.`,
    );
    this.name = 'ReportRowCapExceededError';
  }
}

export class ReportCellCapExceededError extends Error {
  public readonly isDomainError = true;

  public constructor(
    public readonly cap: number,
    public readonly actual: number,
  ) {
    super(
      `Report generated ${actual} grid cells, exceeding the synchronous limit of ${cap}. Please specify a narrower period or fewer dimensions/measures.`,
    );
    this.name = 'ReportCellCapExceededError';
  }
}

export class ReportCellStringLengthExceededError extends Error {
  public readonly isDomainError = true;

  public constructor(public readonly maxLength: number) {
    super(
      `Report cell string length exceeded maximum allowed length of ${maxLength} characters.`,
    );
    this.name = 'ReportCellStringLengthExceededError';
  }
}

export class ReportMissingRateError extends Error {
  public readonly isDomainError = true;

  public constructor(
    public readonly fromCurrency: string,
    public readonly toCurrency: string,
  ) {
    super(`Missing exchange rate from ${fromCurrency} to ${toCurrency}`);
    this.name = 'ReportMissingRateError';
  }
}

export class ReportBudgetMissingError extends Error {
  public readonly isDomainError = true;

  public constructor() {
    super('No budget exists for the requested period.');
    this.name = 'ReportBudgetMissingError';
  }
}

export class ReportPdfRowCapExceededError extends Error {
  public readonly isDomainError = true;

  public constructor(
    public readonly cap: number,
    public readonly actual: number,
  ) {
    super(
      `Report grid contains ${actual} rows, exceeding the PDF render limit of ${cap}. Use json or csv format for large reports.`,
    );
    this.name = 'ReportPdfRowCapExceededError';
  }
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
  createReportRun?(
    subject: string,
    workspaceId: string,
    command: CreateReportRunRequest,
    key: string,
  ): Promise<ReportRunCreateOutcome>;
  getReportRun?(
    subject: string,
    workspaceId: string,
    reportRunId: string,
  ): Promise<ReportRunGetOutcome>;
}

export const REPORT_RUN_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  UNPROCESSABLE: 'unprocessable',
  MISSING_RATE: 'missing_rate',
  NOT_FOUND: 'not_found',
  OK: 'ok',
} as const;

export type ReportRunCreateOutcome =
  | {
      readonly kind: typeof REPORT_RUN_OUTCOMES.CREATED;
      readonly reportRun: ReportRun;
    }
  | {
      readonly kind: typeof REPORT_RUN_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag?: string | null;
      readonly body: unknown;
    }
  | { readonly kind: typeof REPORT_RUN_OUTCOMES.CONFLICT }
  | { readonly kind: typeof REPORT_RUN_OUTCOMES.FORBIDDEN }
  | {
      readonly kind: typeof REPORT_RUN_OUTCOMES.UNPROCESSABLE;
      readonly violations: readonly { field: string; message: string }[];
      readonly detail?: string;
    }
  | {
      readonly kind: typeof REPORT_RUN_OUTCOMES.MISSING_RATE;
      readonly fromCurrency: string;
      readonly toCurrency: string;
    };

export type ReportRunGetOutcome =
  | {
      readonly kind: typeof REPORT_RUN_OUTCOMES.OK;
      readonly reportRun: ReportRun;
    }
  | { readonly kind: typeof REPORT_RUN_OUTCOMES.NOT_FOUND }
  | { readonly kind: typeof REPORT_RUN_OUTCOMES.FORBIDDEN };
