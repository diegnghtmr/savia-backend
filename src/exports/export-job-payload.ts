import { UUID_PATTERN } from '../platform/uuid.js';
import {
  EXPORT_FORMATS,
  EXPORT_RESOURCES,
  type ExportFormat,
  type ExportResource,
} from './export.port.js';

export const EXPORT_JOB_PAYLOAD_VERSION = 1 as const;

export class ExportJobPayloadError extends Error {
  public readonly isDomainError = true;
  public readonly type = 'https://savia.app/problems/invalid-payload';
  public readonly title = 'Invalid Payload';
  public readonly status = 400;
  public readonly code = 'invalid_payload';

  public constructor(message: string) {
    super(message);
    this.name = 'ExportJobPayloadError';
  }
}

export interface ExportJobPayload {
  readonly version: typeof EXPORT_JOB_PAYLOAD_VERSION;
  readonly asOf: string;
  readonly exportJobId: string;
  readonly format: ExportFormat;
  readonly resource: ExportResource;
  readonly resourceId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly objectKey: string;
}

const PAYLOAD_KEYS = [
  'version',
  'asOf',
  'exportJobId',
  'format',
  'resource',
  'resourceId',
  'from',
  'to',
  'objectKey',
] as const;

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CANONICAL_OBJECT_KEY = new RegExp(
  `^(${UUID_PATTERN.source.slice(1, -1)})/(${UUID_PATTERN.source.slice(1, -1)})\\.(json|csv|xlsx)$`,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function isExportFormat(value: unknown): value is ExportFormat {
  return (Object.values(EXPORT_FORMATS) as readonly unknown[]).includes(value);
}

function isExportResource(value: unknown): value is ExportResource {
  return (Object.values(EXPORT_RESOURCES) as readonly unknown[]).includes(
    value,
  );
}

function isUuidOrNull(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && UUID_PATTERN.test(value))
  );
}

function isDateStringOrNull(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && isCanonicalDate(value))
  );
}

export function exportArtifactObjectKey(
  workspaceId: string,
  resourceId: string,
  format: ExportFormat,
): string {
  const ext = format === 'json_backup' ? 'json' : format;
  return `${workspaceId}/${resourceId}.${ext}`;
}

export function parseExportArtifactObjectKey(value: string): {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly extension: string;
} {
  const match = CANONICAL_OBJECT_KEY.exec(value);
  if (!match) {
    throw new ExportJobPayloadError(
      'Export job payload objectKey is not canonical.',
    );
  }
  return {
    workspaceId: match[1] ?? '',
    resourceId: match[2] ?? '',
    extension: match[3] ?? '',
  };
}

export function parseExportJobPayload(
  raw: unknown,
  workspaceId?: string,
): ExportJobPayload {
  if (!isRecord(raw)) {
    throw new ExportJobPayloadError('Export job payload must be an object.');
  }

  const keys = Object.keys(raw);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some(
      (key) => !PAYLOAD_KEYS.includes(key as (typeof PAYLOAD_KEYS)[number]),
    )
  ) {
    throw new ExportJobPayloadError(
      'Export job payload has unknown or missing fields.',
    );
  }

  if (raw.version !== EXPORT_JOB_PAYLOAD_VERSION) {
    throw new ExportJobPayloadError(
      'Export job payload version is not supported.',
    );
  }

  if (typeof raw.asOf !== 'string' || !isCanonicalUtcTimestamp(raw.asOf)) {
    throw new ExportJobPayloadError(
      'Export job payload asOf must be a canonical UTC timestamp.',
    );
  }

  if (
    typeof raw.exportJobId !== 'string' ||
    !UUID_PATTERN.test(raw.exportJobId)
  ) {
    throw new ExportJobPayloadError(
      'Export job payload exportJobId must be a UUID.',
    );
  }

  if (!isExportFormat(raw.format)) {
    throw new ExportJobPayloadError(
      'Export job payload format must be csv, json_backup, or xlsx.',
    );
  }

  if (!isExportResource(raw.resource)) {
    throw new ExportJobPayloadError(
      'Export job payload resource is not supported.',
    );
  }

  if (!isUuidOrNull(raw.resourceId)) {
    throw new ExportJobPayloadError(
      'Export job payload resourceId must be a UUID or null.',
    );
  }

  if (!isDateStringOrNull(raw.from)) {
    throw new ExportJobPayloadError(
      'Export job payload from must be a canonical date (YYYY-MM-DD) or null.',
    );
  }

  if (!isDateStringOrNull(raw.to)) {
    throw new ExportJobPayloadError(
      'Export job payload to must be a canonical date (YYYY-MM-DD) or null.',
    );
  }

  if (typeof raw.objectKey !== 'string') {
    throw new ExportJobPayloadError(
      'Export job payload objectKey must be a canonical object key.',
    );
  }

  const parsedKey = parseExportArtifactObjectKey(raw.objectKey);
  const expectedExt = raw.format === 'json_backup' ? 'json' : raw.format;
  if (
    parsedKey.resourceId !== raw.exportJobId ||
    parsedKey.extension !== expectedExt
  ) {
    throw new ExportJobPayloadError(
      'Export job payload objectKey must match exportJobId and format extension.',
    );
  }

  if (workspaceId !== undefined && parsedKey.workspaceId !== workspaceId) {
    throw new ExportJobPayloadError(
      'Export job payload objectKey must match the job workspace.',
    );
  }

  return {
    version: EXPORT_JOB_PAYLOAD_VERSION,
    asOf: raw.asOf,
    exportJobId: raw.exportJobId,
    format: raw.format,
    resource: raw.resource,
    resourceId: raw.resourceId,
    from: raw.from,
    to: raw.to,
    objectKey: raw.objectKey,
  };
}

export function freezeExportJobPayload(
  payload: ExportJobPayload,
): Record<string, unknown> {
  return {
    version: payload.version,
    asOf: payload.asOf,
    exportJobId: payload.exportJobId,
    format: payload.format,
    resource: payload.resource,
    resourceId: payload.resourceId,
    from: payload.from,
    to: payload.to,
    objectKey: payload.objectKey,
  };
}
