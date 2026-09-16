import { UUID_PATTERN } from '../platform/uuid.js';
import {
  REPORT_DIMENSIONS,
  REPORT_MEASURES,
  REPORT_RUN_FORMAT,
  type ReportDimension,
  type ReportMeasure,
  type ReportRunFormat,
} from './report.port.js';
import { parseReportArtifactObjectKey } from './report-run-snapshot.js';

export const REPORT_JOB_PAYLOAD_VERSION = 1 as const;

export class ReportJobPayloadError extends Error {
  public readonly isDomainError = true;
  public readonly code = 'INVALID_PAYLOAD';

  public constructor(message: string) {
    super(message);
    this.name = 'ReportJobPayloadError';
  }
}

export interface ReportJobPayload {
  readonly version: typeof REPORT_JOB_PAYLOAD_VERSION;
  readonly asOf: string;
  readonly reportRunId: string;
  readonly format: ReportRunFormat;
  readonly definitionId: string | null;
  readonly preset: string | null;
  readonly filters: Record<string, unknown>;
  readonly periodStart: string;
  readonly periodTo: string;
  readonly shapeTypeFilter: string | null;
  readonly callerType: string | null;
  readonly dimensions: readonly ReportDimension[];
  readonly measures: readonly ReportMeasure[];
  readonly objectKey: string;
  readonly baseCurrency: string;
}

const PAYLOAD_KEYS = [
  'version',
  'asOf',
  'reportRunId',
  'format',
  'definitionId',
  'preset',
  'filters',
  'periodStart',
  'periodTo',
  'shapeTypeFilter',
  'callerType',
  'dimensions',
  'measures',
  'objectKey',
  'baseCurrency',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!CANONICAL_UTC_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalDate(value: string): boolean {
  if (!CANONICAL_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isReportRunFormat(value: unknown): value is ReportRunFormat {
  return (Object.values(REPORT_RUN_FORMAT) as readonly unknown[]).includes(
    value,
  );
}

function isDimensionArray(value: unknown): value is readonly ReportDimension[] {
  return (
    Array.isArray(value) &&
    value.every((item) =>
      (REPORT_DIMENSIONS as readonly string[]).includes(item as string),
    )
  );
}

function isMeasureArray(value: unknown): value is readonly ReportMeasure[] {
  return (
    Array.isArray(value) &&
    value.every((item) =>
      (REPORT_MEASURES as readonly string[]).includes(item as string),
    )
  );
}

function isUuidOrNull(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && UUID_PATTERN.test(value))
  );
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function parseReportJobPayload(
  raw: unknown,
  workspaceId?: string,
): ReportJobPayload {
  if (!isRecord(raw)) {
    throw new ReportJobPayloadError('Report job payload must be an object.');
  }

  const keys = Object.keys(raw);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some(
      (key) => !PAYLOAD_KEYS.includes(key as (typeof PAYLOAD_KEYS)[number]),
    )
  ) {
    throw new ReportJobPayloadError(
      'Report job payload has unknown or missing fields.',
    );
  }

  if (raw.version !== REPORT_JOB_PAYLOAD_VERSION) {
    throw new ReportJobPayloadError(
      'Report job payload version is not supported.',
    );
  }

  if (typeof raw.asOf !== 'string' || !isCanonicalUtcTimestamp(raw.asOf)) {
    throw new ReportJobPayloadError(
      'Report job payload asOf must be a canonical UTC timestamp.',
    );
  }

  if (
    typeof raw.reportRunId !== 'string' ||
    !UUID_PATTERN.test(raw.reportRunId)
  ) {
    throw new ReportJobPayloadError(
      'Report job payload reportRunId must be a UUID.',
    );
  }

  if (!isReportRunFormat(raw.format)) {
    throw new ReportJobPayloadError(
      'Report job payload format must be json, csv, or pdf.',
    );
  }

  if (!isUuidOrNull(raw.definitionId)) {
    throw new ReportJobPayloadError(
      'Report job payload definitionId must be a UUID or null.',
    );
  }

  if (!isStringOrNull(raw.preset)) {
    throw new ReportJobPayloadError(
      'Report job payload preset must be a string or null.',
    );
  }

  if (!isRecord(raw.filters)) {
    throw new ReportJobPayloadError(
      'Report job payload filters must be an object.',
    );
  }

  if (
    typeof raw.periodStart !== 'string' ||
    !isCanonicalDate(raw.periodStart)
  ) {
    throw new ReportJobPayloadError(
      'Report job payload periodStart must be a canonical date.',
    );
  }

  if (typeof raw.periodTo !== 'string' || !isCanonicalDate(raw.periodTo)) {
    throw new ReportJobPayloadError(
      'Report job payload periodTo must be a canonical date.',
    );
  }

  if (!isStringOrNull(raw.shapeTypeFilter)) {
    throw new ReportJobPayloadError(
      'Report job payload shapeTypeFilter must be a string or null.',
    );
  }

  if (!isStringOrNull(raw.callerType)) {
    throw new ReportJobPayloadError(
      'Report job payload callerType must be a string or null.',
    );
  }

  if (!isDimensionArray(raw.dimensions)) {
    throw new ReportJobPayloadError(
      'Report job payload dimensions must be an array of report dimensions.',
    );
  }

  if (!isMeasureArray(raw.measures)) {
    throw new ReportJobPayloadError(
      'Report job payload measures must be an array of report measures.',
    );
  }

  if (typeof raw.objectKey !== 'string') {
    throw new ReportJobPayloadError(
      'Report job payload objectKey must be a canonical object key.',
    );
  }
  let parsedKey;
  try {
    parsedKey = parseReportArtifactObjectKey(raw.objectKey);
  } catch {
    throw new ReportJobPayloadError(
      'Report job payload objectKey must be a canonical object key.',
    );
  }
  if (
    parsedKey.resourceId !== raw.reportRunId ||
    parsedKey.format !== raw.format
  ) {
    throw new ReportJobPayloadError(
      'Report job payload objectKey must match reportRunId and format.',
    );
  }
  if (workspaceId !== undefined && parsedKey.workspaceId !== workspaceId) {
    throw new ReportJobPayloadError(
      'Report job payload objectKey must match the job workspace.',
    );
  }

  if (typeof raw.baseCurrency !== 'string' || raw.baseCurrency.trim() === '') {
    throw new ReportJobPayloadError(
      'Report job payload baseCurrency must be a non-empty string.',
    );
  }

  return {
    version: REPORT_JOB_PAYLOAD_VERSION,
    asOf: raw.asOf,
    reportRunId: raw.reportRunId,
    format: raw.format,
    definitionId: raw.definitionId,
    preset: raw.preset,
    filters: { ...raw.filters },
    periodStart: raw.periodStart,
    periodTo: raw.periodTo,
    shapeTypeFilter: raw.shapeTypeFilter,
    callerType: raw.callerType,
    dimensions: [...raw.dimensions],
    measures: [...raw.measures],
    objectKey: raw.objectKey,
    baseCurrency: raw.baseCurrency,
  };
}

export function freezeReportJobPayload(
  payload: ReportJobPayload,
): Record<string, unknown> {
  return {
    version: payload.version,
    asOf: payload.asOf,
    reportRunId: payload.reportRunId,
    format: payload.format,
    definitionId: payload.definitionId,
    preset: payload.preset,
    filters: { ...payload.filters },
    periodStart: payload.periodStart,
    periodTo: payload.periodTo,
    shapeTypeFilter: payload.shapeTypeFilter,
    callerType: payload.callerType,
    dimensions: [...payload.dimensions],
    measures: [...payload.measures],
    objectKey: payload.objectKey,
    baseCurrency: payload.baseCurrency,
  };
}
