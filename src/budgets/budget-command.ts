import {
  add,
  sortViolations,
  type FieldViolation,
} from '../platform/field-validation.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  BUDGET_METHODS,
  type CreateBudgetRequest,
  type UpdateBudgetRequest,
} from './budget.port.js';

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
