import {
  add,
  currencyValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  RATE_TYPE,
  type CreateDebtPaymentRequest,
  type CreateDebtRequest,
  type Money,
  type RateType,
} from './debt.port.js';

export class DebtCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Debt command validation failed.');
    this.name = 'DebtCommandValidationError';
  }
}

const CREATE_DEBT_FIELDS = [
  'name',
  'principal',
  'annualRate',
  'rateType',
  'minimumPayment',
  'startDate',
  'termMonths',
] as const;

const CREATE_DEBT_PAYMENT_FIELDS = [
  'accountId',
  'totalAmount',
  'principalAmount',
  'interestAmount',
  'feeAmount',
  'occurredAt',
] as const;

const MONEY_FIELDS = ['amountMinor', 'currency'] as const;
const INTEGER_PATTERN = /^-?[0-9]+$/;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const DECIMAL_PATTERN = /^-?[0-9]+(?:\.[0-9]+)?$/;

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_PATTERN.test(v)) {
    return false;
  }
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parseMoney(
  value: unknown,
  field: string,
  violations: FieldViolation[],
  requirePositive = true,
): Money | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add(violations, field, 'invalid-type', 'must be an object');
    return undefined;
  }
  const m = value as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MONEY_FIELDS.includes(key as (typeof MONEY_FIELDS)[number])) {
      add(violations, `${field}.${key}`, 'not-allowed', 'is not allowed');
    }
  }

  let amountMinor: string | undefined;
  if (m.amountMinor === undefined) {
    add(
      violations,
      `${field}.amountMinor`,
      'required',
      'must be a non-empty string',
    );
  } else if (typeof m.amountMinor !== 'string') {
    add(violations, `${field}.amountMinor`, 'invalid-type', 'must be a string');
  } else if (m.amountMinor.includes('\0')) {
    add(
      violations,
      `${field}.amountMinor`,
      'invalid-characters',
      'must not contain null characters',
    );
  } else {
    const trimmed = m.amountMinor.trim();
    if (!trimmed) {
      add(
        violations,
        `${field}.amountMinor`,
        'required',
        'must be a non-empty string',
      );
    } else if (!INTEGER_PATTERN.test(trimmed)) {
      add(
        violations,
        `${field}.amountMinor`,
        'invalid-format',
        'must be an integer minor-unit amount string',
      );
    } else {
      try {
        const val = BigInt(trimmed);
        if (val < INT64_MIN || val > INT64_MAX) {
          add(
            violations,
            `${field}.amountMinor`,
            'invalid-range',
            'must be within 64-bit signed integer range',
          );
        } else if (requirePositive && val <= 0n) {
          add(
            violations,
            `${field}.amountMinor`,
            'invalid-range',
            'must be greater than zero',
          );
        } else if (!requirePositive && val < 0n) {
          add(
            violations,
            `${field}.amountMinor`,
            'invalid-range',
            'must be greater than or equal to zero',
          );
        } else {
          amountMinor = trimmed;
        }
      } catch {
        add(
          violations,
          `${field}.amountMinor`,
          'invalid-range',
          'must be within 64-bit signed integer range',
        );
      }
    }
  }

  const currency = currencyValue(m.currency, `${field}.currency`, violations);

  if (amountMinor !== undefined && currency) {
    return {
      amountMinor,
      currency,
    };
  }
  return undefined;
}

export function createDebtCommand(input: unknown): CreateDebtRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new DebtCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !CREATE_DEBT_FIELDS.includes(key as (typeof CREATE_DEBT_FIELDS)[number])
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let name = '';
  if (body.name === undefined) {
    add(violations, 'name', 'required', 'must be a non-empty string');
  } else if (typeof body.name !== 'string') {
    add(violations, 'name', 'invalid-type', 'must be a string');
  } else if (body.name.includes('\0')) {
    add(
      violations,
      'name',
      'invalid-characters',
      'must not contain null characters',
    );
  } else {
    const trimmed = body.name.trim();
    if (!trimmed) {
      add(violations, 'name', 'required', 'must be a non-empty string');
    } else if ([...trimmed].length > 120) {
      add(violations, 'name', 'max-length', 'must be at most 120 characters');
    } else {
      name = trimmed;
    }
  }

  const principal = parseMoney(body.principal, 'principal', violations, true);

  let annualRate = '';
  if (body.annualRate === undefined) {
    add(violations, 'annualRate', 'required', 'must be a non-empty string');
  } else if (typeof body.annualRate !== 'string') {
    add(violations, 'annualRate', 'invalid-type', 'must be a string');
  } else if (body.annualRate.includes('\0')) {
    add(
      violations,
      'annualRate',
      'invalid-characters',
      'must not contain null characters',
    );
  } else {
    const trimmed = body.annualRate.trim();
    if (!trimmed) {
      add(violations, 'annualRate', 'required', 'must be a non-empty string');
    } else if (!DECIMAL_PATTERN.test(trimmed)) {
      add(
        violations,
        'annualRate',
        'invalid-format',
        'must be a valid decimal string',
      );
    } else if (trimmed.startsWith('-')) {
      add(
        violations,
        'annualRate',
        'invalid-range',
        'annualRate must be non-negative',
      );
    } else {
      annualRate = trimmed;
    }
  }

  let rateType: RateType = RATE_TYPE.FIXED;
  const validRateTypes: readonly string[] = Object.values(RATE_TYPE);
  if (body.rateType === undefined) {
    add(violations, 'rateType', 'required', 'must be a valid rate type');
  } else if (typeof body.rateType !== 'string') {
    add(violations, 'rateType', 'invalid-type', 'must be a string');
  } else if (!validRateTypes.includes(body.rateType)) {
    add(
      violations,
      'rateType',
      'invalid-value',
      'must be either fixed or variable',
    );
  } else {
    rateType = body.rateType as RateType;
  }

  let minimumPayment: Money | undefined;
  if (body.minimumPayment !== undefined && body.minimumPayment !== null) {
    minimumPayment = parseMoney(
      body.minimumPayment,
      'minimumPayment',
      violations,
      false,
    );
    if (
      minimumPayment !== undefined &&
      principal !== undefined &&
      minimumPayment.currency !== principal.currency
    ) {
      add(
        violations,
        'minimumPayment.currency',
        'invalid',
        'must match debt currency',
      );
    }
  }

  let startDate: string | null = null;
  if (body.startDate !== undefined && body.startDate !== null) {
    if (typeof body.startDate !== 'string') {
      add(violations, 'startDate', 'invalid-type', 'must be a string or null');
    } else if (!validDate(body.startDate)) {
      add(
        violations,
        'startDate',
        'invalid-format',
        'must be a valid UTC calendar date (YYYY-MM-DD)',
      );
    } else {
      startDate = body.startDate;
    }
  }

  let termMonths: number | null = null;
  if (body.termMonths !== undefined && body.termMonths !== null) {
    if (
      typeof body.termMonths !== 'number' ||
      !Number.isInteger(body.termMonths)
    ) {
      add(
        violations,
        'termMonths',
        'invalid-type',
        'must be an integer or null',
      );
    } else if (body.termMonths < 1) {
      add(violations, 'termMonths', 'invalid-range', 'must be at least 1');
    } else {
      termMonths = body.termMonths;
    }
  }

  if (violations.length > 0) {
    throw new DebtCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    name,
    principal: principal!,
    annualRate,
    rateType,
    ...(minimumPayment !== undefined ? { minimumPayment } : {}),
    startDate,
    termMonths,
  };
}

export function createDebtPaymentCommand(
  input: unknown,
): CreateDebtPaymentRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new DebtCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !CREATE_DEBT_PAYMENT_FIELDS.includes(
        key as (typeof CREATE_DEBT_PAYMENT_FIELDS)[number],
      )
    ) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  }

  let accountId = '';
  if (body.accountId === undefined) {
    add(violations, 'accountId', 'required', 'must be a valid UUID');
  } else if (typeof body.accountId !== 'string') {
    add(violations, 'accountId', 'invalid-type', 'must be a string');
  } else if (!UUID_PATTERN.test(body.accountId.trim())) {
    add(violations, 'accountId', 'invalid-format', 'must be a valid UUID');
  } else {
    accountId = body.accountId.trim().toLowerCase();
  }

  const totalAmount = parseMoney(
    body.totalAmount,
    'totalAmount',
    violations,
    true,
  );

  let occurredAt = '';
  if (body.occurredAt === undefined) {
    add(violations, 'occurredAt', 'required', 'must be a non-empty string');
  } else if (typeof body.occurredAt !== 'string') {
    add(violations, 'occurredAt', 'invalid-type', 'must be a string');
  } else {
    const trimmed = body.occurredAt.trim();
    if (!trimmed || !ISO_DATE_TIME_PATTERN.test(trimmed)) {
      add(
        violations,
        'occurredAt',
        'invalid-date',
        'must be a valid ISO 8601 date-time string',
      );
    } else {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        add(
          violations,
          'occurredAt',
          'invalid-date',
          'must be a valid ISO 8601 date-time string',
        );
      } else {
        occurredAt = trimmed;
      }
    }
  }

  let principalAmount: Money | undefined;
  if (body.principalAmount !== undefined && body.principalAmount !== null) {
    principalAmount = parseMoney(
      body.principalAmount,
      'principalAmount',
      violations,
      false,
    );
    if (
      principalAmount !== undefined &&
      totalAmount !== undefined &&
      principalAmount.currency !== totalAmount.currency
    ) {
      add(
        violations,
        'principalAmount.currency',
        'invalid',
        'must match totalAmount currency',
      );
    }
  }

  let interestAmount: Money | undefined;
  if (body.interestAmount !== undefined && body.interestAmount !== null) {
    interestAmount = parseMoney(
      body.interestAmount,
      'interestAmount',
      violations,
      false,
    );
    if (
      interestAmount !== undefined &&
      totalAmount !== undefined &&
      interestAmount.currency !== totalAmount.currency
    ) {
      add(
        violations,
        'interestAmount.currency',
        'invalid',
        'must match totalAmount currency',
      );
    }
  }

  let feeAmount: Money | undefined;
  if (body.feeAmount !== undefined && body.feeAmount !== null) {
    feeAmount = parseMoney(body.feeAmount, 'feeAmount', violations, false);
    if (
      feeAmount !== undefined &&
      totalAmount !== undefined &&
      feeAmount.currency !== totalAmount.currency
    ) {
      add(
        violations,
        'feeAmount.currency',
        'invalid',
        'must match totalAmount currency',
      );
    }
  }

  /*
   * THE SPLIT INVARIANT (Slice 6.5 §5.1):
   * principalAmount, interestAmount, and feeAmount are all optional in the contract.
   * - If NONE of the three is supplied: the ENTIRE totalAmount reduces the principal.
   *   There is no amortization engine in this system and inventing one is out of scope.
   * - If ANY of the three is supplied: they must ALL sum to exactly totalAmount.
   *   principal + interest + fee == total, with absent parts treated as zero.
   *   If they do not sum exactly -> 422 with a violation naming the offending fields,
   *   and NOTHING written.
   * - Only principalAmount reduces the outstanding balance. Interest and fees do not.
   * - Every supplied part must be >= 0, and totalAmount must be > 0.
   */
  const hasPrincipal =
    body.principalAmount !== undefined && body.principalAmount !== null;
  const hasInterest =
    body.interestAmount !== undefined && body.interestAmount !== null;
  const hasFee = body.feeAmount !== undefined && body.feeAmount !== null;

  if (hasPrincipal || hasInterest || hasFee) {
    if (
      totalAmount !== undefined &&
      (!hasPrincipal || principalAmount !== undefined) &&
      (!hasInterest || interestAmount !== undefined) &&
      (!hasFee || feeAmount !== undefined)
    ) {
      const p = hasPrincipal ? BigInt(principalAmount!.amountMinor) : 0n;
      const i = hasInterest ? BigInt(interestAmount!.amountMinor) : 0n;
      const f = hasFee ? BigInt(feeAmount!.amountMinor) : 0n;
      const total = BigInt(totalAmount.amountMinor);

      if (p + i + f !== total) {
        add(
          violations,
          'totalAmount',
          'invalid-sum',
          'The sum of principalAmount, interestAmount, and feeAmount must equal totalAmount',
        );
        if (hasPrincipal) {
          add(
            violations,
            'principalAmount',
            'invalid-sum',
            'The sum of principalAmount, interestAmount, and feeAmount must equal totalAmount',
          );
        }
        if (hasInterest) {
          add(
            violations,
            'interestAmount',
            'invalid-sum',
            'The sum of principalAmount, interestAmount, and feeAmount must equal totalAmount',
          );
        }
        if (hasFee) {
          add(
            violations,
            'feeAmount',
            'invalid-sum',
            'The sum of principalAmount, interestAmount, and feeAmount must equal totalAmount',
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new DebtCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }

  return {
    accountId,
    totalAmount: totalAmount!,
    ...(principalAmount !== undefined ? { principalAmount } : {}),
    ...(interestAmount !== undefined ? { interestAmount } : {}),
    ...(feeAmount !== undefined ? { feeAmount } : {}),
    occurredAt,
  };
}
