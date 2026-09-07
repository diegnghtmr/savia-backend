import {
  add,
  type FieldViolation,
  sortViolations,
} from '../platform/field-validation.js';
import {
  RECEIPT_PROCESSING_PREFERENCES,
  type ReceiptField,
  type ReceiptProcessingPreference,
} from './receipt.port.js';

const FIELDS = ['merchant', 'date', 'currency', 'total'] as const;
type ReceiptFieldName = (typeof FIELDS)[number];

export class ReceiptCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Receipt command validation failed.');
    this.name = 'ReceiptCommandValidationError';
  }
}

export function parseProcessingPreference(
  value: unknown,
): ReceiptProcessingPreference {
  if (value === undefined || value === '')
    return RECEIPT_PROCESSING_PREFERENCES.SAVIA;
  if (
    value === RECEIPT_PROCESSING_PREFERENCES.DEVICE_RESULT ||
    value === RECEIPT_PROCESSING_PREFERENCES.SAVIA ||
    value === RECEIPT_PROCESSING_PREFERENCES.EXTERNAL_PROVIDER
  )
    return value;
  throw new ReceiptCommandValidationError([
    {
      field: 'processingPreference',
      code: 'invalid-value',
      message: 'is not supported',
    },
  ]);
}

export function parseDeviceOcrResult(
  value: unknown,
): Record<string, unknown> | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalidOcr('deviceOcrResult');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidOcr('deviceOcrResult');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw invalidOcr('deviceOcrResult');
  const result = parsed as Record<string, unknown>;
  const violations: FieldViolation[] = [];
  for (const field of FIELDS) {
    if (!(field in result)) continue;
    const candidate = result[field];
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      add(
        violations,
        `deviceOcrResult.${field}`,
        'invalid-type',
        'must be an object',
      );
      continue;
    }
    const entry = candidate as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (
      keys.length !== 2 ||
      !keys.includes('value') ||
      !keys.includes('confidence')
    )
      add(
        violations,
        `deviceOcrResult.${field}`,
        'invalid-properties',
        'must contain exactly value and confidence',
      );
    if (
      typeof entry.confidence !== 'number' ||
      !Number.isFinite(entry.confidence) ||
      entry.confidence < 0 ||
      entry.confidence > 1
    )
      add(
        violations,
        `deviceOcrResult.${field}.confidence`,
        'invalid-range',
        'must be a number between 0 and 1',
      );
  }
  if (violations.length)
    throw new ReceiptCommandValidationError(sortViolations(violations));
  return result;
}

export function toReceiptFields(
  result: Record<string, unknown> | null,
): Record<ReceiptFieldName, ReceiptField | null> {
  return Object.fromEntries(
    FIELDS.map((field) => {
      const value = result?.[field];
      return [field, value === undefined ? null : (value as ReceiptField)];
    }),
  ) as Record<ReceiptFieldName, ReceiptField | null>;
}

function invalidOcr(field: string): ReceiptCommandValidationError {
  return new ReceiptCommandValidationError([
    { field, code: 'invalid-type', message: 'must be a JSON object' },
  ]);
}
