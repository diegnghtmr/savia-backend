import type { FieldViolation } from '../platform/problem-details.js';
import { parseListQuery, DEFAULT_LIST_LIMIT } from '../platform/list-query.js';
import type { RecurringRuleListQuery } from './recurring.port.js';

export const RECURRING_LIST_DEFAULT_LIMIT = DEFAULT_LIST_LIMIT;

export class RecurringQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Recurring rule list query validation failed.');
    this.name = 'RecurringQueryValidationError';
  }
}

export interface RecurringRuleListQueryInput {
  readonly workspaceId: string;
  readonly cursorParam?: string;
  readonly limitParam?: string;
}

export function createRecurringRuleListQuery(
  input: RecurringRuleListQueryInput,
): RecurringRuleListQuery {
  const base = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
    expectedWorkspaceId: input.workspaceId,
  });

  if (base.violations.length > 0) {
    throw new RecurringQueryValidationError(base.violations);
  }

  return {
    workspaceId: input.workspaceId,
    ...(base.cursor === undefined ? {} : { cursor: base.cursor }),
    limit: base.limit,
  };
}
