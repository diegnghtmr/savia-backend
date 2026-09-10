import {
  parseListQuery,
  type ListQueryResult,
} from '../platform/list-query.js';
import type { FieldViolation } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { BudgetListQuery } from './budget.port.js';
export class BudgetQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Budget query validation failed.');
    this.name = 'BudgetQueryValidationError';
  }
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function date(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function createBudgetListQuery(input: {
  workspaceId: string;
  cursorParam?: string;
  limitParam?: string;
  fromParam?: string;
  toParam?: string;
}): BudgetListQuery {
  const violations: FieldViolation[] = [];
  if (!UUID_PATTERN.test(input.workspaceId))
    violations.push(
      Object.freeze({
        field: 'workspaceId',
        code: 'invalid',
        message: 'workspaceId must be a valid UUID.',
      }),
    );
  for (const [field, value] of [
    ['from', input.fromParam],
    ['to', input.toParam],
  ] as const)
    if (value !== undefined && !date(value))
      violations.push(
        Object.freeze({
          field,
          code: 'invalid',
          message: `${field} must be a valid UTC date.`,
        }),
      );
  if (
    input.fromParam &&
    input.toParam &&
    date(input.fromParam) &&
    date(input.toParam) &&
    input.fromParam > input.toParam
  )
    violations.push(
      Object.freeze({
        field: 'to',
        code: 'invalid-range',
        message: 'to must not be before from.',
      }),
    );
  const filter = JSON.stringify([
    input.fromParam ?? null,
    input.toParam ?? null,
  ]);
  const parsed: ListQueryResult = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
    expectedWorkspaceId: input.workspaceId,
    expectedFilter: filter,
  });
  violations.push(...parsed.violations);
  if (violations.length)
    throw new BudgetQueryValidationError(Object.freeze(violations));
  return {
    workspaceId: input.workspaceId,
    limit: parsed.limit,
    cursor: parsed.cursor,
    ...(input.fromParam ? { from: input.fromParam } : {}),
    ...(input.toParam ? { to: input.toParam } : {}),
  };
}
export function validateBudgetId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim()))
    throw new BudgetQueryValidationError([
      Object.freeze({
        field: 'budgetId',
        code: 'invalid',
        message: 'budgetId must be a valid UUID.',
      }),
    ]);
  return value.trim().toLowerCase();
}
