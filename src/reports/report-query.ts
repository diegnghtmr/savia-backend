import {
  parseListQuery,
  type ListQueryResult,
} from '../platform/list-query.js';
import type { FieldViolation } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { ReportListQuery } from './report.port.js';

export class ReportQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Report query validation failed.');
    this.name = 'ReportQueryValidationError';
  }
}

export function createReportListQuery(input: {
  workspaceId: string;
  cursorParam?: string;
  limitParam?: string;
}): ReportListQuery {
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
    throw new ReportQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    limit: parsed.limit,
    ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
  };
}
