import {
  add,
  currencyValue,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  BUDGET_METHODS,
  type CreateBudgetRequest,
  type UpdateBudgetRequest,
  type UpdateBudgetAllocationsRequest,
  ROLLOVER_POLICIES,
} from './budget.port.js';
import { MAX_BUDGET_ALLOCATION_COUNT } from './budget-limits.js';

export class BudgetCommandValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Budget command validation failed.');
    this.name = 'BudgetCommandValidationError';
  }
}
const FIELDS = [
  'name',
  'method',
  'periodStart',
  'periodEnd',
  'copyFromBudgetId',
] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function createBudgetCommand(input: unknown): CreateBudgetRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new BudgetCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }
  const body = input as Record<string, unknown>;
  Object.keys(body).forEach((key) => {
    if (!FIELDS.includes(key as (typeof FIELDS)[number]))
      add(violations, key, 'not-allowed', 'is not allowed');
  });
  const name = body.name;
  if (typeof name !== 'string' || name.length < 1 || name.length > 120)
    add(violations, 'name', 'invalid', 'must be between 1 and 120 characters');
  const methods = Object.values(BUDGET_METHODS);
  if (
    typeof body.method !== 'string' ||
    !methods.includes(body.method as never)
  )
    add(violations, 'method', 'invalid', 'must be a supported budget method');
  for (const field of ['periodStart', 'periodEnd'] as const)
    if (!validDate(body[field]))
      add(
        violations,
        field,
        'invalid-format',
        'must be a valid UTC calendar date (YYYY-MM-DD)',
      );
  if (validDate(body.periodStart) && validDate(body.periodEnd)) {
    const start = Date.parse(`${body.periodStart}T00:00:00Z`);
    const end = Date.parse(`${body.periodEnd}T00:00:00Z`);
    const days = (end - start) / 86400000;
    if (days <= 0)
      add(
        violations,
        'periodEnd',
        'invalid-range',
        'must be after periodStart',
      );
    else if (days > 366)
      add(
        violations,
        'periodEnd',
        'invalid-range',
        'period must not span more than 366 days',
      );
  }
  if (
    body.copyFromBudgetId !== undefined &&
    body.copyFromBudgetId !== null &&
    (typeof body.copyFromBudgetId !== 'string' ||
      !UUID_PATTERN.test(body.copyFromBudgetId))
  )
    add(
      violations,
      'copyFromBudgetId',
      'invalid-format',
      'must be a valid UUID or null',
    );
  if (violations.length)
    throw new BudgetCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return {
    name: name as string,
    method: body.method as CreateBudgetRequest['method'],
    periodStart: body.periodStart as string,
    periodEnd: body.periodEnd as string,
    ...(body.copyFromBudgetId !== undefined
      ? { copyFromBudgetId: body.copyFromBudgetId as string | null }
      : {}),
  };
}

const UPDATE_FIELDS = ['name', 'method'] as const;
export function updateBudgetCommand(input: unknown): UpdateBudgetRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new BudgetCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0) {
    add(
      violations,
      'body',
      'min-properties',
      'must have at least one property',
    );
  }
  keys.forEach((key) => {
    if (!UPDATE_FIELDS.includes(key as (typeof UPDATE_FIELDS)[number])) {
      add(violations, key, 'not-allowed', 'is not allowed');
    }
  });
  if (body.name !== undefined) {
    const name = body.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > 120) {
      add(
        violations,
        'name',
        'invalid',
        'must be between 1 and 120 characters',
      );
    }
  }
  if (body.method !== undefined) {
    const methods = Object.values(BUDGET_METHODS);
    if (
      typeof body.method !== 'string' ||
      !methods.includes(body.method as never)
    ) {
      add(violations, 'method', 'invalid', 'must be a supported budget method');
    }
  }
  if (violations.length) {
    throw new BudgetCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }
  const result: { name?: string; method?: UpdateBudgetRequest['method'] } = {};
  if (body.name !== undefined) {
    result.name = body.name as string;
  }
  if (body.method !== undefined) {
    result.method = body.method as UpdateBudgetRequest['method'];
  }
  return result;
}

const ALLOCATION_FIELDS = [
  'categoryId',
  'planned',
  'rolloverPolicy',
  'rolloverTargetId',
] as const;
const MONEY_FIELDS = ['amountMinor', 'currency'] as const;
const INTEGER = /^-?[0-9]+$/;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

export function updateBudgetAllocationsCommand(
  input: unknown,
): UpdateBudgetAllocationsRequest {
  const violations: FieldViolation[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    add(violations, 'body', 'invalid-type', 'must be an object');
    throw new BudgetCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'allocations'))
    for (const key of Object.keys(body))
      if (key !== 'allocations')
        add(violations, key, 'not-allowed', 'is not allowed');
  if (!Array.isArray(body.allocations)) {
    add(violations, 'allocations', 'required', 'must be an array');
  } else if (body.allocations.length > MAX_BUDGET_ALLOCATION_COUNT) {
    add(
      violations,
      'allocations',
      'max-items',
      `must contain at most ${MAX_BUDGET_ALLOCATION_COUNT} items`,
    );
  }
  const allocations: Array<
    UpdateBudgetAllocationsRequest['allocations'][number]
  > = [];
  const seen = new Set<string>();
  if (Array.isArray(body.allocations)) {
    body.allocations.forEach((raw, index) => {
      const field = `allocations[${index}]`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        add(violations, field, 'invalid-type', 'must be an object');
        return;
      }
      const item = raw as Record<string, unknown>;
      for (const key of Object.keys(item))
        if (
          !ALLOCATION_FIELDS.includes(key as (typeof ALLOCATION_FIELDS)[number])
        )
          add(violations, `${field}.${key}`, 'not-allowed', 'is not allowed');
      const categoryId = item.categoryId;
      if (typeof categoryId !== 'string' || !UUID_PATTERN.test(categoryId))
        add(
          violations,
          `${field}.categoryId`,
          'invalid-format',
          'must be a valid UUID',
        );
      else if (seen.has(categoryId))
        add(
          violations,
          `${field}.categoryId`,
          'duplicate',
          'must be unique within allocations',
        );
      else seen.add(categoryId);
      const money = item.planned;
      let amountMinor = '';
      let currency = '';
      if (typeof money !== 'object' || money === null || Array.isArray(money)) {
        add(
          violations,
          `${field}.planned`,
          'invalid-type',
          'must be an object',
        );
      } else {
        const m = money as Record<string, unknown>;
        for (const key of Object.keys(m))
          if (!MONEY_FIELDS.includes(key as (typeof MONEY_FIELDS)[number]))
            add(
              violations,
              `${field}.planned.${key}`,
              'not-allowed',
              'is not allowed',
            );
        if (m.amountMinor === undefined)
          add(
            violations,
            `${field}.planned.amountMinor`,
            'required',
            'must be a non-empty string',
          );
        else if (typeof m.amountMinor !== 'string')
          add(
            violations,
            `${field}.planned.amountMinor`,
            'invalid-type',
            'must be a string',
          );
        else if (m.amountMinor.includes('\0'))
          add(
            violations,
            `${field}.planned.amountMinor`,
            'invalid-characters',
            'must not contain null characters',
          );
        else {
          const trimmed = m.amountMinor.trim();
          if (!trimmed)
            add(
              violations,
              `${field}.planned.amountMinor`,
              'required',
              'must be a non-empty string',
            );
          else if (!INTEGER.test(trimmed))
            add(
              violations,
              `${field}.planned.amountMinor`,
              'invalid-format',
              'must be an integer minor-unit amount string',
            );
          else {
            const value = BigInt(trimmed);
            if (value < INT64_MIN || value > INT64_MAX)
              add(
                violations,
                `${field}.planned.amountMinor`,
                'invalid-range',
                'must be within 64-bit signed integer range',
              );
            else amountMinor = trimmed;
          }
        }
        currency = currencyValue(
          m.currency,
          `${field}.planned.currency`,
          violations,
        );
      }
      const policy = item.rolloverPolicy;
      const policies = Object.values(ROLLOVER_POLICIES);
      if (typeof policy !== 'string' || !policies.includes(policy as never))
        add(
          violations,
          `${field}.rolloverPolicy`,
          'unsupported',
          'must be a supported rollover policy',
        );
      const target = item.rolloverTargetId;
      if (
        target !== undefined &&
        target !== null &&
        (typeof target !== 'string' || !UUID_PATTERN.test(target))
      )
        add(
          violations,
          `${field}.rolloverTargetId`,
          'invalid-format',
          'must be a valid UUID or null',
        );
      if (policy === 'to_category' && (target === undefined || target === null))
        add(
          violations,
          `${field}.rolloverTargetId`,
          'required',
          'is required for to_category',
        );
      if (policy === 'to_fund')
        add(
          violations,
          `${field}.rolloverTargetId`,
          'unsupported',
          'fund targets are not yet available',
        );
      if (
        ['none', 'surplus', 'deficit', 'both', 'to_savings'].includes(
          policy as string,
        ) &&
        target !== undefined &&
        target !== null
      )
        add(
          violations,
          `${field}.rolloverTargetId`,
          'not-allowed',
          'must be null or absent for this rollover policy',
        );
      if (
        typeof categoryId === 'string' &&
        UUID_PATTERN.test(categoryId) &&
        typeof policy === 'string' &&
        policies.includes(policy as never) &&
        typeof money === 'object' &&
        money !== null
      )
        allocations.push({
          categoryId,
          planned: { amountMinor, currency },
          rolloverPolicy: policy as never,
          ...(target !== undefined
            ? { rolloverTargetId: target as string | null }
            : {}),
        });
    });
  }
  if (violations.length)
    throw new BudgetCommandValidationError(
      Object.freeze(sortViolations(violations)),
    );
  return { allocations };
}
