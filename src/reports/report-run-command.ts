import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import { REPORT_PRESETS_LIST, type ReportPreset } from './report-presets.js';
import type { ReportRunFormat, CreateReportRunRequest } from './report.port.js';

export class ReportRunCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Report run command validation failed.');
    this.name = 'ReportRunCommandValidationError';
  }
}

const FORMATS = ['json', 'csv', 'pdf'] as const;
const FIELDS = ['definitionId', 'preset', 'format', 'filters'] as const;

export function createReportRunCommand(input: unknown): CreateReportRunRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ReportRunCommandValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  }
  const definitionId = body.definitionId;
  const preset = body.preset;
  if (
    definitionId !== undefined &&
    definitionId !== null &&
    (typeof definitionId !== 'string' || !UUID_PATTERN.test(definitionId))
  ) {
    add(violations, 'definitionId', 'invalid', 'must be a UUID or null');
  }
  if (
    preset !== undefined &&
    preset !== null &&
    (typeof preset !== 'string' ||
      !REPORT_PRESETS_LIST.includes(preset as ReportPreset))
  ) {
    add(
      violations,
      'preset',
      'invalid',
      'must be a supported report preset or null',
    );
  }
  if (
    (definitionId !== undefined && preset !== undefined) ||
    (definitionId === undefined && preset === undefined)
  ) {
    add(
      violations,
      'body',
      'invalid',
      'exactly one of definitionId and preset is required',
    );
  }
  if (
    typeof body.format !== 'string' ||
    !FORMATS.includes(body.format as ReportRunFormat)
  ) {
    add(violations, 'format', 'invalid', 'must be json, csv, or pdf');
  }
  let filters: Record<string, unknown> = {};
  if (body.filters !== undefined) {
    if (
      typeof body.filters !== 'object' ||
      body.filters === null ||
      Array.isArray(body.filters)
    )
      add(violations, 'filters', 'invalid-type', 'must be an object');
    else filters = body.filters as Record<string, unknown>;
  }
  for (const field of ['from', 'to'] as const) {
    const value = filters[field];
    if (
      value !== undefined &&
      (typeof value !== 'string' || !isIsoDate(value))
    ) {
      add(
        violations,
        `filters.${field}`,
        'invalid',
        'must be a valid YYYY-MM-DD date',
      );
    }
  }
  if (
    typeof filters.from === 'string' &&
    typeof filters.to === 'string' &&
    isIsoDate(filters.from) &&
    isIsoDate(filters.to) &&
    filters.from > filters.to
  ) {
    add(
      violations,
      'filters.to',
      'invalid-range',
      'to must not be before from.',
    );
  }
  if (violations.length > 0)
    throw new ReportRunCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return {
    ...(definitionId !== undefined
      ? { definitionId: definitionId as string | null }
      : {}),
    ...(preset !== undefined ? { preset: preset as ReportPreset | null } : {}),
    format: body.format as ReportRunFormat,
    filters,
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return parsed.toISOString().slice(0, 10) === value;
}
