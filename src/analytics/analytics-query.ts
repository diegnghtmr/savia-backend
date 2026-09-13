import { ACTIVE_CURRENCIES } from '../platform/field-validation.js';
import type { FieldViolation } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  ADVANCED_METRIC,
  GRANULARITY,
  type AdvancedAnalyticsQuery,
  type AdvancedMetric,
  type AnalyticsSummaryQuery,
  type CashFlowAnalyticsQuery,
  type Granularity,
} from './analytics.port.js';

export class AnalyticsQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Analytics query validation failed.');
    this.name = 'AnalyticsQueryValidationError';
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 4.1 Period definition:
 * Evaluated in UTC, YYYY-MM-DD.
 * Validates that string conforms to YYYY-MM-DD and resolves to the identical UTC calendar date.
 */
function isValidUtcDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function createAnalyticsSummaryQuery(input: {
  workspaceId: string;
  fromParam?: string;
  toParam?: string;
  presentationCurrencyParam?: string;
}): AnalyticsSummaryQuery {
  const violations: FieldViolation[] = [];

  if (!UUID_PATTERN.test(input.workspaceId)) {
    violations.push({
      field: 'workspaceId',
      code: 'invalid',
      message: 'workspaceId must be a valid UUID.',
    });
  }

  if (!input.fromParam) {
    violations.push({
      field: 'from',
      code: 'required',
      message: 'from is required.',
    });
  } else if (!isValidUtcDate(input.fromParam)) {
    violations.push({
      field: 'from',
      code: 'invalid',
      message: 'from must be a valid UTC date (YYYY-MM-DD).',
    });
  }

  if (!input.toParam) {
    violations.push({
      field: 'to',
      code: 'required',
      message: 'to is required.',
    });
  } else if (!isValidUtcDate(input.toParam)) {
    violations.push({
      field: 'to',
      code: 'invalid',
      message: 'to must be a valid UTC date (YYYY-MM-DD).',
    });
  }

  // 4.1 Period: from > to -> 400
  if (
    input.fromParam &&
    input.toParam &&
    isValidUtcDate(input.fromParam) &&
    isValidUtcDate(input.toParam) &&
    input.fromParam > input.toParam
  ) {
    violations.push({
      field: 'to',
      code: 'invalid-range',
      message: 'to must not be before from.',
    });
  }

  let presentationCurrency: string | undefined;
  if (input.presentationCurrencyParam !== undefined) {
    const candidate = input.presentationCurrencyParam.trim().toUpperCase();
    if (!ACTIVE_CURRENCIES.has(candidate)) {
      violations.push({
        field: 'presentationCurrency',
        code: 'invalid-currency',
        message: 'presentationCurrency must be an active ISO 4217 currency.',
      });
    } else {
      presentationCurrency = candidate;
    }
  }

  if (violations.length > 0) {
    throw new AnalyticsQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    from: input.fromParam!,
    to: input.toParam!,
    ...(presentationCurrency ? { presentationCurrency } : {}),
  };
}

export function createCashFlowAnalyticsQuery(input: {
  workspaceId: string;
  fromParam?: string;
  toParam?: string;
  granularityParam?: string;
}): CashFlowAnalyticsQuery {
  const violations: FieldViolation[] = [];

  if (!UUID_PATTERN.test(input.workspaceId)) {
    violations.push({
      field: 'workspaceId',
      code: 'invalid',
      message: 'workspaceId must be a valid UUID.',
    });
  }

  if (!input.fromParam) {
    violations.push({
      field: 'from',
      code: 'required',
      message: 'from is required.',
    });
  } else if (!isValidUtcDate(input.fromParam)) {
    violations.push({
      field: 'from',
      code: 'invalid',
      message: 'from must be a valid UTC date (YYYY-MM-DD).',
    });
  }

  if (!input.toParam) {
    violations.push({
      field: 'to',
      code: 'required',
      message: 'to is required.',
    });
  } else if (!isValidUtcDate(input.toParam)) {
    violations.push({
      field: 'to',
      code: 'invalid',
      message: 'to must be a valid UTC date (YYYY-MM-DD).',
    });
  }

  // 4.1 Period: from > to -> 400
  if (
    input.fromParam &&
    input.toParam &&
    isValidUtcDate(input.fromParam) &&
    isValidUtcDate(input.toParam) &&
    input.fromParam > input.toParam
  ) {
    violations.push({
      field: 'to',
      code: 'invalid-range',
      message: 'to must not be before from.',
    });
  }

  // 4.6 Granularity: day | week | month | quarter, default month
  let granularity: Granularity = GRANULARITY.MONTH;
  if (input.granularityParam !== undefined) {
    const raw = input.granularityParam.trim().toLowerCase();
    if (Object.values(GRANULARITY).includes(raw as Granularity)) {
      granularity = raw as Granularity;
    } else {
      violations.push({
        field: 'granularity',
        code: 'invalid-granularity',
        message: `granularity must be one of: ${Object.values(GRANULARITY).join(', ')}.`,
      });
    }
  }

  if (violations.length > 0) {
    throw new AnalyticsQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    from: input.fromParam!,
    to: input.toParam!,
    granularity,
  };
}

export function createAdvancedAnalyticsQuery(
  input: {
    workspaceId: string;
    metricParam?: string;
    fromParam?: string;
    toParam?: string;
  },
  nowUtc: Date = new Date(),
): AdvancedAnalyticsQuery {
  const violations: FieldViolation[] = [];

  if (!UUID_PATTERN.test(input.workspaceId)) {
    violations.push({
      field: 'workspaceId',
      code: 'invalid',
      message: 'workspaceId must be a valid UUID.',
    });
  }

  let metric: AdvancedMetric | undefined = undefined;
  if (!input.metricParam || input.metricParam.trim() === '') {
    violations.push({
      field: 'metric',
      code: 'required',
      message: 'metric is required.',
    });
  } else {
    const raw = input.metricParam.trim().toLowerCase();
    const allowedMetrics = Object.values(ADVANCED_METRIC);
    if (!allowedMetrics.includes(raw as AdvancedMetric)) {
      violations.push({
        field: 'metric',
        code: 'invalid-metric',
        message: `metric must be one of: ${allowedMetrics.join(', ')}.`,
      });
    } else {
      metric = raw as AdvancedMetric;
    }
  }

  let to: string | undefined = undefined;
  if (input.toParam !== undefined) {
    if (!isValidUtcDate(input.toParam)) {
      violations.push({
        field: 'to',
        code: 'invalid',
        message: 'to must be a valid UTC date (YYYY-MM-DD).',
      });
    } else {
      to = input.toParam;
    }
  } else {
    to = nowUtc.toISOString().slice(0, 10);
  }

  let from: string | undefined = undefined;
  if (input.fromParam !== undefined) {
    if (!isValidUtcDate(input.fromParam)) {
      violations.push({
        field: 'from',
        code: 'invalid',
        message: 'from must be a valid UTC date (YYYY-MM-DD).',
      });
    } else {
      from = input.fromParam;
    }
  } else if (to !== undefined && isValidUtcDate(to)) {
    // from omitted -> first day of the month 11 months before the month of to
    const toYear = parseInt(to.slice(0, 4), 10);
    const toMonth = parseInt(to.slice(5, 7), 10);
    from = new Date(Date.UTC(toYear, toMonth - 12, 1))
      .toISOString()
      .slice(0, 10);
  }

  if (
    from !== undefined &&
    to !== undefined &&
    isValidUtcDate(from) &&
    isValidUtcDate(to) &&
    from > to
  ) {
    violations.push({
      field: 'to',
      code: 'invalid-range',
      message: 'to must not be before from.',
    });
  }

  if (violations.length > 0 || !metric || !from || !to) {
    throw new AnalyticsQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    metric,
    from,
    to,
  };
}
