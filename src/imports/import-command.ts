import {
  IMPORT_FORMATS,
  DEBIT_SIGNS,
  type ImportCommand,
  type CommitImportCommand,
} from './import.port.js';
import { UUID_PATTERN } from '../platform/uuid.js';
export function validateFormatHint(
  value: unknown,
): ImportCommand['formatHint'] {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !IMPORT_FORMATS.includes(value as never))
    throw new Error('formatHint must be csv, xlsx, qif, ofx, qfx, or null.');
  return value as ImportCommand['formatHint'];
}
export function validateCommitImportCommand(
  value: unknown,
): CommitImportCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Commit request must be an object.');
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'accountId',
    'columnMapping',
    'dateFormat',
    'debitSign',
    'skipDuplicateCandidates',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error('Commit request contains unknown properties.');
  if (
    typeof input.accountId !== 'string' ||
    !UUID_PATTERN.test(input.accountId.trim()) ||
    !input.columnMapping ||
    typeof input.columnMapping !== 'object' ||
    Array.isArray(input.columnMapping)
  )
    throw new Error(
      'accountId must be a valid UUID and columnMapping is required.',
    );
  const columnMapping: Record<string, string> = {};
  for (const [source, target] of Object.entries(input.columnMapping))
    if (typeof target !== 'string')
      throw new Error('columnMapping values must be strings.');
    else columnMapping[source] = target;
  const debitSign = input.debitSign === undefined ? undefined : input.debitSign;
  if (
    debitSign !== undefined &&
    !Object.values(DEBIT_SIGNS).includes(debitSign as never)
  )
    throw new Error('debitSign is invalid.');
  if (
    input.dateFormat !== undefined &&
    input.dateFormat !== null &&
    typeof input.dateFormat !== 'string'
  )
    throw new Error('dateFormat is invalid.');
  if (
    input.skipDuplicateCandidates !== undefined &&
    typeof input.skipDuplicateCandidates !== 'boolean'
  )
    throw new Error('skipDuplicateCandidates is invalid.');
  return {
    accountId: input.accountId,
    columnMapping,
    dateFormat: input.dateFormat as string | null | undefined,
    debitSign: debitSign as CommitImportCommand['debitSign'],
    skipDuplicateCandidates: input.skipDuplicateCandidates as
      | boolean
      | undefined,
  };
}
