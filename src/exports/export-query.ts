import { UUID_PATTERN } from '../platform/uuid.js';
export class ExportQueryValidationError extends Error {
  public constructor(
    public readonly violations: readonly {
      field: string;
      code: string;
      message: string;
    }[],
  ) {
    super('Export query validation failed.');
  }
}
export function validateExportJobId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim()))
    throw new ExportQueryValidationError([
      {
        field: 'exportJobId',
        code: 'invalid',
        message: 'exportJobId must be a valid UUID.',
      },
    ]);
  return value.trim().toLowerCase();
}
