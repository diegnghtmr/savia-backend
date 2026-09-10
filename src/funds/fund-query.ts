import {
  parseListQuery,
  type ListQueryResult,
} from '../platform/list-query.js';
import type { FieldViolation } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { FundListQuery } from './fund.port.js';

export class FundQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Fund query validation failed.');
    this.name = 'FundQueryValidationError';
  }
}

export function createFundListQuery(input: {
  workspaceId: string;
  cursorParam?: string;
  limitParam?: string;
}): FundListQuery {
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
    throw new FundQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    limit: parsed.limit,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

export function validateFundId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new FundQueryValidationError([
      Object.freeze({
        field: 'fundId',
        code: 'invalid',
        message: 'fundId must be a valid UUID.',
      }),
    ]);
  }
  return value.trim().toLowerCase();
}
