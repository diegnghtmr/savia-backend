import {
  parseListQuery,
  type ListQueryResult,
} from '../platform/list-query.js';
import type { FieldViolation } from '../platform/problem-details.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import type { ScenarioListQuery } from './scenario.port.js';

export class ScenarioQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Scenario query validation failed.');
    this.name = 'ScenarioQueryValidationError';
  }
}

export function createScenarioListQuery(input: {
  workspaceId: string;
  cursorParam?: string;
  limitParam?: string;
}): ScenarioListQuery {
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
    throw new ScenarioQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    limit: parsed.limit,
    ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
  };
}
