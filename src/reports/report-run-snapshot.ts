import { REPORT_RUN_FORMAT, type ReportRunFormat } from './report.port.js';

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CANONICAL_OBJECT_KEY = new RegExp(
  `^(${CANONICAL_UUID.source.slice(1, -1)})/(${CANONICAL_UUID.source.slice(1, -1)})\\.(json|csv|pdf)$`,
);

export class ReportArtifactObjectKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReportArtifactObjectKeyError';
  }
}

export interface ReportArtifactObjectKey {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly format: ReportRunFormat;
}

function isReportRunFormat(value: string): value is ReportRunFormat {
  return (Object.values(REPORT_RUN_FORMAT) as readonly string[]).includes(
    value,
  );
}

export function reportArtifactObjectKey(
  workspaceId: string,
  resourceId: string,
  format: ReportRunFormat,
): string {
  return `${workspaceId}/${resourceId}.${format}`;
}

export function parseReportArtifactObjectKey(
  value: string,
): ReportArtifactObjectKey {
  const match = CANONICAL_OBJECT_KEY.exec(value);
  if (!match) {
    throw new ReportArtifactObjectKeyError(
      'Report artifact object key is not canonical.',
    );
  }
  const format = match[3];
  if (!format || !isReportRunFormat(format)) {
    throw new ReportArtifactObjectKeyError(
      'Report artifact object key is not canonical.',
    );
  }
  return {
    workspaceId: match[1] ?? '',
    resourceId: match[2] ?? '',
    format,
  };
}
