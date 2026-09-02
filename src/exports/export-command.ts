import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  EXPORT_FORMATS,
  EXPORT_RESOURCES,
  type CreateExportJobCommand,
} from './export.port.js';
export class ExportCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Export command validation failed.');
    this.name = 'ExportCommandValidationError';
  }
}
const fields = ['format', 'resource', 'resourceId', 'from', 'to'] as const;
const date = /^\d{4}-\d{2}-\d{2}$/;
function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !date.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function createExportCommand(input: unknown): CreateExportJobCommand {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new ExportCommandValidationError(sortViolations(violations));
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body))
    if (!fields.includes(key as (typeof fields)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  const format = body.format;
  const resource = body.resource ?? 'all';
  if (!Object.values(EXPORT_FORMATS).includes(format as never))
    add(
      violations,
      'format',
      'invalid-value',
      'must be csv, json_backup, or xlsx',
    );
  if (!Object.values(EXPORT_RESOURCES).includes(resource as never))
    add(
      violations,
      'resource',
      'invalid-value',
      'must be a declared export resource',
    );
  const resourceId =
    body.resourceId === undefined || body.resourceId === null
      ? null
      : body.resourceId;
  if (
    resourceId !== null &&
    (typeof resourceId !== 'string' || !UUID_PATTERN.test(resourceId))
  )
    add(
      violations,
      'resourceId',
      'invalid-format',
      'must be a valid UUID or null',
    );
  if (resourceId !== null && resource !== 'report')
    add(
      violations,
      'resourceId',
      'not-supported',
      'resourceId is only meaningful for report',
    );
  const from = body.from === undefined || body.from === null ? null : body.from;
  const to = body.to === undefined || body.to === null ? null : body.to;
  if (from !== null && !validDate(from))
    add(
      violations,
      'from',
      'invalid-format',
      'must be a valid UTC date or null',
    );
  if (to !== null && !validDate(to))
    add(violations, 'to', 'invalid-format', 'must be a valid UTC date or null');
  if (
    typeof from === 'string' &&
    typeof to === 'string' &&
    validDate(from) &&
    validDate(to) &&
    from > to
  )
    add(violations, 'from', 'invalid-range', 'must not be later than to');
  if (violations.length)
    throw new ExportCommandValidationError(sortViolations(violations));
  return {
    format: format as CreateExportJobCommand['format'],
    resource: resource as CreateExportJobCommand['resource'],
    resourceId: resourceId as string | null,
    from: from as string | null,
    to: to as string | null,
  };
}
