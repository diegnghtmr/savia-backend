import { IMPORT_FORMATS, type ImportCommand } from './import.port.js';
export function validateFormatHint(
  value: unknown,
): ImportCommand['formatHint'] {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !IMPORT_FORMATS.includes(value as never))
    throw new Error('formatHint must be csv, xlsx, qif, ofx, qfx, or null.');
  return value as ImportCommand['formatHint'];
}
