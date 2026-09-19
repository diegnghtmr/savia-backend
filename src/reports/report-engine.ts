import {
  GRANULARITY,
  truncateToBucketStart,
} from '../platform/monthly-capacity.js';
import {
  computeIncreasePercentHundredths,
  formatHundredths,
  roundDivHalfAwayFromZero,
} from '../platform/percentage-change.js';
import {
  getReportGridCellCap,
  getReportMaxCellStringLength,
  REPORT_DIMENSION,
  REPORT_DIMENSIONS,
  REPORT_MEASURE,
  REPORT_MEASURES,
  ReportCellCapExceededError,
  ReportCellStringLengthExceededError,
  type ReportDimension,
  type ReportMeasure,
  type ReportSourceRow,
} from './report.port.js';
export type { ReportSourceRow } from './report.port.js';

export const UNIT_SEPARATOR = '\x1f';

export interface ReportEngineInput {
  readonly rows: readonly ReportSourceRow[];
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly baseCurrency: string;
  readonly budgetedMinorByBucket: ReadonlyMap<string, bigint>;
}

export interface ReportCell {
  readonly measure: ReportMeasure;
  readonly value: string | null;
}

export interface ReportRow {
  readonly key: readonly string[];
  readonly cells: readonly ReportCell[];
}

export interface ReportGrid {
  readonly rows: readonly ReportRow[];
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly baseCurrency: string;
  readonly warnings: readonly string[];
}

const ALLOWED_DIMENSIONS = new Set<string>(REPORT_DIMENSIONS);
const ALLOWED_MEASURES = new Set<string>(REPORT_MEASURES);

const TEMPORAL_DIMENSIONS = new Set<ReportDimension>([
  REPORT_DIMENSION.DATE,
  REPORT_DIMENSION.DAY,
  REPORT_DIMENSION.WEEK,
  REPORT_DIMENSION.MONTH,
  REPORT_DIMENSION.QUARTER,
  REPORT_DIMENSION.YEAR,
]);

const TAG_WARNING =
  'Rows are counted once per tag; totals across tag buckets may exceed the grand total.';
const MIXED_CURRENCY_WARNING =
  'Native sum is undefined for buckets mixing currencies; use converted_value.';

function getDimensionValues(
  dim: ReportDimension,
  row: ReportSourceRow,
): readonly string[] {
  switch (dim) {
    case REPORT_DIMENSION.DATE:
      return [row.occurredAt.toISOString().slice(0, 10)];
    case REPORT_DIMENSION.DAY:
      return [truncateToBucketStart(row.occurredAt, GRANULARITY.DAY)];
    case REPORT_DIMENSION.WEEK:
      return [truncateToBucketStart(row.occurredAt, GRANULARITY.WEEK)];
    case REPORT_DIMENSION.MONTH:
      return [truncateToBucketStart(row.occurredAt, GRANULARITY.MONTH)];
    case REPORT_DIMENSION.QUARTER:
      return [truncateToBucketStart(row.occurredAt, GRANULARITY.QUARTER)];
    case REPORT_DIMENSION.YEAR:
      return [truncateToBucketStart(row.occurredAt, GRANULARITY.YEAR)];
    case REPORT_DIMENSION.ACCOUNT:
      return [row.accountId];
    case REPORT_DIMENSION.ACCOUNT_TYPE:
      return [row.accountType];
    case REPORT_DIMENSION.CURRENCY:
      return [row.currency];
    case REPORT_DIMENSION.MEMBER:
      return [row.memberId];
    case REPORT_DIMENSION.STATUS:
      return [row.status];
    case REPORT_DIMENSION.TRANSACTION_TYPE:
      return [row.type];
    case REPORT_DIMENSION.CATEGORY:
      return [row.categoryId ?? 'uncategorized'];
    case REPORT_DIMENSION.PAYEE:
      return [row.payee ?? 'unknown'];
    case REPORT_DIMENSION.TAG:
      return row.tags.length > 0 ? row.tags : ['untagged'];
  }
}

function expandKeyTuples(
  dimensions: readonly ReportDimension[],
  row: ReportSourceRow,
): string[][] {
  if (dimensions.length === 0) {
    return [[]];
  }
  let tuples: string[][] = [[]];
  for (const dim of dimensions) {
    const vals = getDimensionValues(dim, row);
    const nextTuples: string[][] = [];
    for (const tuple of tuples) {
      for (const val of vals) {
        nextTuples.push([...tuple, val]);
      }
    }
    tuples = nextTuples;
  }
  return tuples;
}

interface BucketData {
  readonly key: readonly string[];
  readonly rows: ReportSourceRow[];
}

function compareBuckets(
  a: BucketData,
  b: BucketData,
  dimensions: readonly ReportDimension[],
): number {
  for (let i = 0; i < dimensions.length; i++) {
    const dim = dimensions[i];
    const valA = a.key[i];
    const valB = b.key[i];
    if (valA === valB) {
      continue;
    }
    if (TEMPORAL_DIMENSIONS.has(dim)) {
      return valA < valB ? -1 : 1;
    }
    return valA < valB ? -1 : 1;
  }
  return 0;
}

export function buildReportGrid(input: ReportEngineInput): ReportGrid {
  // C.5 Allow-list validation: reject any non-permitted dimension or measure by throwing
  for (const dim of input.dimensions) {
    if (!ALLOWED_DIMENSIONS.has(dim)) {
      throw new Error(`Invalid report dimension: "${dim}" is not permitted.`);
    }
  }
  for (const measure of input.measures) {
    if (!ALLOWED_MEASURES.has(measure)) {
      throw new Error(`Invalid report measure: "${measure}" is not permitted.`);
    }
  }

  const warnings: string[] = [];
  if (input.dimensions.includes(REPORT_DIMENSION.TAG)) {
    warnings.push(TAG_WARNING);
  }

  // Group rows into buckets
  const bucketMap = new Map<string, BucketData>();
  for (const row of input.rows) {
    const keyTuples = expandKeyTuples(input.dimensions, row);
    for (const key of keyTuples) {
      const compositeKey = key.join(UNIT_SEPARATOR);
      let bucket = bucketMap.get(compositeKey);
      if (!bucket) {
        bucket = { key, rows: [] };
        bucketMap.set(compositeKey, bucket);
      }
      bucket.rows.push(row);
    }
  }

  // Emitted order: sort buckets
  const sortedBuckets = Array.from(bucketMap.values()).sort((a, b) =>
    compareBuckets(a, b, input.dimensions),
  );

  // Pre-calculate sums and grand total of S across all buckets
  const sPerBucket: bigint[] = [];
  let grandTotal = 0n;
  for (const b of sortedBuckets) {
    let s = 0n;
    for (const r of b.rows) {
      s += r.convertedMinor;
    }
    sPerBucket.push(s);
    grandTotal += s;
  }

  // Evaluate measures across sorted buckets
  let runningBalance = 0n;
  let hasMixedCurrencyWarning = false;

  const reportRows: ReportRow[] = [];

  for (let i = 0; i < sortedBuckets.length; i++) {
    const b = sortedBuckets[i];
    const S = sPerBucket[i];
    runningBalance += S;

    const cells: ReportCell[] = [];

    for (const measure of input.measures) {
      let value: string | null = null;

      switch (measure) {
        case REPORT_MEASURE.CONVERTED_VALUE:
          value = S.toString();
          break;

        case REPORT_MEASURE.SUM: {
          const currencies = new Set(b.rows.map((r) => r.currency));
          if (currencies.size <= 1) {
            let sumNative = 0n;
            for (const r of b.rows) {
              sumNative += r.amountMinor;
            }
            value = sumNative.toString();
          } else {
            value = null;
            if (!hasMixedCurrencyWarning) {
              hasMixedCurrencyWarning = true;
              warnings.push(MIXED_CURRENCY_WARNING);
            }
          }
          break;
        }

        case REPORT_MEASURE.COUNT:
          value = BigInt(b.rows.length).toString();
          break;

        case REPORT_MEASURE.AVERAGE: {
          const count = BigInt(b.rows.length);
          if (count === 0n) {
            value = null;
          } else {
            value = roundDivHalfAwayFromZero(S, count).toString();
          }
          break;
        }

        case REPORT_MEASURE.MINIMUM: {
          if (b.rows.length === 0) {
            value = null;
          } else {
            let min = b.rows[0].convertedMinor;
            for (let k = 1; k < b.rows.length; k++) {
              if (b.rows[k].convertedMinor < min) {
                min = b.rows[k].convertedMinor;
              }
            }
            value = min.toString();
          }
          break;
        }

        case REPORT_MEASURE.MAXIMUM: {
          if (b.rows.length === 0) {
            value = null;
          } else {
            let max = b.rows[0].convertedMinor;
            for (let k = 1; k < b.rows.length; k++) {
              if (b.rows[k].convertedMinor > max) {
                max = b.rows[k].convertedMinor;
              }
            }
            value = max.toString();
          }
          break;
        }

        case REPORT_MEASURE.PERCENTAGE: {
          if (grandTotal === 0n) {
            value = null;
          } else {
            const hundredths = roundDivHalfAwayFromZero(S * 10000n, grandTotal);
            value = formatHundredths(hundredths);
          }
          break;
        }

        case REPORT_MEASURE.BALANCE:
          value = runningBalance.toString();
          break;

        case REPORT_MEASURE.VARIATION: {
          if (i === 0) {
            value = null;
          } else {
            const prevS = sPerBucket[i - 1];
            const hundredths = computeIncreasePercentHundredths(
              { amountMinor: prevS.toString(), currency: input.baseCurrency },
              { amountMinor: S.toString(), currency: input.baseCurrency },
            );
            value = hundredths === null ? null : formatHundredths(hundredths);
          }
          break;
        }

        case REPORT_MEASURE.MOVING_AVERAGE: {
          if (i < 2) {
            value = null;
          } else {
            const windowSum =
              sPerBucket[i - 2] + sPerBucket[i - 1] + sPerBucket[i];
            const mean = roundDivHalfAwayFromZero(windowSum, 3n);
            value = mean.toString();
          }
          break;
        }

        case REPORT_MEASURE.BUDGET: {
          const bucketKey = b.key.join(UNIT_SEPARATOR);
          const budgeted = input.budgetedMinorByBucket.get(bucketKey);
          value = budgeted !== undefined ? budgeted.toString() : null;
          break;
        }

        case REPORT_MEASURE.VARIANCE: {
          const bucketKey = b.key.join(UNIT_SEPARATOR);
          const budgeted = input.budgetedMinorByBucket.get(bucketKey);
          value = budgeted !== undefined ? (budgeted - S).toString() : null;
          break;
        }
      }

      cells.push({ measure, value });
    }

    reportRows.push({ key: b.key, cells });
  }

  const gridCellCap = getReportGridCellCap();
  const maxCellLength = getReportMaxCellStringLength();
  const totalCells = reportRows.length * input.measures.length;
  if (Number.isFinite(gridCellCap) && totalCells > gridCellCap) {
    throw new ReportCellCapExceededError(gridCellCap, totalCells);
  }

  for (const row of reportRows) {
    for (const k of row.key) {
      if (k.length > maxCellLength) {
        throw new ReportCellStringLengthExceededError(maxCellLength);
      }
    }
    for (const cell of row.cells) {
      if (cell.value && cell.value.length > maxCellLength) {
        throw new ReportCellStringLengthExceededError(maxCellLength);
      }
    }
  }

  return {
    rows: reportRows,
    dimensions: input.dimensions,
    measures: input.measures,
    baseCurrency: input.baseCurrency,
    warnings,
  };
}

export const computeReportGrid = buildReportGrid;
export const executeReport = buildReportGrid;
export const runReportEngine = buildReportGrid;
