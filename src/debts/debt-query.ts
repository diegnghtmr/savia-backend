import {
  parseListQuery,
  type ListQueryResult,
} from '../platform/list-query.js';
import type { FieldViolation } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { DebtListQuery } from './debt.port.js';

export class DebtQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Debt query validation failed.');
    this.name = 'DebtQueryValidationError';
  }
}

export function createDebtListQuery(input: {
  workspaceId: string;
  cursorParam?: string;
  limitParam?: string;
}): DebtListQuery {
  const violations: FieldViolation[] = [];
  if (!UUID_PATTERN.test(input.workspaceId)) {
    violations.push(
      Object.freeze({
        field: 'workspaceId',
        code: 'invalid',
        message: 'workspaceId must be a valid UUID.',
      }),
    );
  }

  const parsed: ListQueryResult = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
    expectedWorkspaceId: input.workspaceId,
  });

  violations.push(...parsed.violations);
  if (violations.length > 0) {
    throw new DebtQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    limit: parsed.limit,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

export function validateDebtId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new DebtQueryValidationError([
      Object.freeze({
        field: 'debtId',
        code: 'invalid',
        message: 'debtId must be a valid UUID.',
      }),
    ]);
  }
  return value.trim().toLowerCase();
}
