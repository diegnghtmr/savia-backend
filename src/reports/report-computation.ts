import { computeReportGrid, type ReportGrid } from './report-engine.js';
import type {
  ReportDimension,
  ReportMeasure,
  ReportSourceRow,
} from './report.port.js';

export interface ReportComputationShape {
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly typeFilter?: string;
  readonly filters?: Record<string, unknown>;
}

export interface ResolvedReportPeriod {
  readonly periodStart: string;
  readonly periodTo: string;
}

export function resolveShapeTypeFilter(
  shape: ReportComputationShape,
): string | undefined {
  const defFilters =
    typeof shape.filters === 'object' && shape.filters !== null
      ? shape.filters
      : undefined;
  return 'typeFilter' in shape
    ? shape.typeFilter
    : typeof defFilters?.type === 'string'
      ? defFilters.type
      : undefined;
}

export function resolveReportPeriod(
  now: Date,
  definitionFilters: Record<string, unknown> | undefined,
  commandFilters: Record<string, unknown>,
): ResolvedReportPeriod {
  const periodEnd = now.toISOString().slice(0, 10);
  const defaultStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
  )
    .toISOString()
    .slice(0, 10);

  const defFrom =
    typeof definitionFilters?.from === 'string'
      ? definitionFilters.from
      : undefined;
  const callerFrom =
    typeof commandFilters.from === 'string' ? commandFilters.from : undefined;

  let periodStart: string;
  if (defFrom && callerFrom) {
    periodStart = defFrom > callerFrom ? defFrom : callerFrom;
  } else if (defFrom) {
    periodStart = defFrom;
  } else if (callerFrom) {
    periodStart = callerFrom;
  } else {
    periodStart = defaultStart;
  }

  const defTo =
    typeof definitionFilters?.to === 'string'
      ? definitionFilters.to
      : undefined;
  const callerTo =
    typeof commandFilters.to === 'string' ? commandFilters.to : undefined;

  let periodTo: string;
  if (defTo && callerTo) {
    periodTo = defTo < callerTo ? defTo : callerTo;
  } else if (defTo) {
    periodTo = defTo;
  } else if (callerTo) {
    periodTo = callerTo;
  } else {
    periodTo = periodEnd;
  }

  return { periodStart, periodTo };
}

export function computePreparedReportGrid(input: {
  readonly rows: readonly ReportSourceRow[];
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly baseCurrency: string;
  readonly budgetedMinorByBucket: ReadonlyMap<string, bigint>;
  readonly preset?: string | null;
}): ReportGrid {
  let grid = computeReportGrid({
    rows: input.rows,
    dimensions: input.dimensions,
    measures: input.measures,
    baseCurrency: input.baseCurrency,
    budgetedMinorByBucket: input.budgetedMinorByBucket,
  });
  if (input.preset === 'budget') {
    const unbudgetedCount = grid.rows.filter(
      (row) =>
        row.cells.find((cell) => cell.measure === 'budget')?.value === null,
    ).length;
    if (unbudgetedCount > 0) {
      const warningMessage = `${unbudgetedCount} ${unbudgetedCount === 1 ? 'bucket had' : 'buckets had'} no budget.`;
      grid = {
        ...grid,
        warnings: [...grid.warnings, warningMessage],
      };
    }
  }
  return grid;
}
