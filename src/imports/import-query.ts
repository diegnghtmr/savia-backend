import { UUID_PATTERN } from '../platform/uuid.js';
export function validateImportJobId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim()))
    throw new Error('importJobId must be a valid UUID.');
  return value.trim().toLowerCase();
}
