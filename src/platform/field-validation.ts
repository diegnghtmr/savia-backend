import type { FieldViolation } from './problem-details.js';

export type { FieldViolation };

export const ACTIVE_CURRENCIES: ReadonlySet<string> = new Set(
  Intl.supportedValuesOf('currency'),
);

export function add(
  violations: FieldViolation[],
  field: string,
  code: string,
  message: string,
): void {
  violations.push(Object.freeze({ field, code, message }));
}

export function stringValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
): string {
  if (typeof value !== 'string') {
    add(violations, field, 'required', 'must be a non-empty string');
    return '';
  }
  // PostgreSQL text columns cannot represent U+0000 and raise SQLSTATE 22021
  // (invalid byte sequence for encoding "UTF8": 0x00), which a length check does not catch.
  if (value.includes('\0')) {
    add(
      violations,
      field,
      'invalid-characters',
      'must not contain null characters',
    );
    return '';
  }
  const trimmed = value.trim();
  if (trimmed) return trimmed;
  add(violations, field, 'required', 'must be a non-empty string');
  return '';
}

export function nameValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
  maxLength = 120,
): string {
  const name = stringValue(value, field, violations);
  if ([...name].length > maxLength) {
    add(
      violations,
      field,
      'max-length',
      `must be at most ${maxLength} characters`,
    );
  }
  return name;
}

export function currencyValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
): string {
  const currency = stringValue(value, field, violations).toUpperCase();
  if (!ACTIVE_CURRENCIES.has(currency)) {
    add(
      violations,
      field,
      'invalid-currency',
      'must be an active ISO 4217 currency',
    );
  }
  return currency;
}

export function enumValue<T extends readonly string[]>(
  value: unknown,
  field: string,
  values: T,
  violations: FieldViolation[],
  message = 'is unsupported',
): T[number] {
  const candidate = stringValue(value, field, violations);
  if (!values.includes(candidate as T[number])) {
    add(violations, field, 'unsupported', message);
  }
  return candidate as T[number];
}

export function optionalStringValue(
  value: unknown,
  field: string,
  violations: FieldViolation[],
  maxLength?: number,
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    add(violations, field, 'invalid-type', 'must be a string');
    return null;
  }
  if (value.includes('\0')) {
    add(
      violations,
      field,
      'invalid-characters',
      'must not contain null characters',
    );
    return null;
  }
  if (maxLength !== undefined && [...value].length > maxLength) {
    add(
      violations,
      field,
      'max-length',
      `must be at most ${maxLength} characters`,
    );
    return null;
  }
  return value;
}

export function optionalBooleanValue<T extends boolean>(
  value: unknown,
  field: string,
  violations: FieldViolation[],
  defaultValue: T,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    add(violations, field, 'invalid-type', 'must be a boolean');
    return defaultValue;
  }
  return value;
}

export function sortViolations(violations: FieldViolation[]): FieldViolation[] {
  return violations.sort(
    (left, right) =>
      left.field.localeCompare(right.field) ||
      left.message.localeCompare(right.message),
  );
}
