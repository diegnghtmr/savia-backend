import type { Cursor } from './cursor.js';
import { decodeCursor } from './cursor.js';
import type { FieldViolation } from './problem-details.js';

export const DEFAULT_LIST_LIMIT = 50;
const LIMIT_PATTERN = /^\d+$/;

export interface ListQueryInput {
  readonly cursorParam?: string;
  readonly limitParam?: string;
  readonly expectedWorkspaceId?: string;
}

export interface ListQueryResult {
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly violations: readonly FieldViolation[];
}

export function parseListQuery(input: ListQueryInput): ListQueryResult {
  const violations: FieldViolation[] = [];

  let limit = DEFAULT_LIST_LIMIT;
  if (input.limitParam !== undefined) {
    if (!LIMIT_PATTERN.test(input.limitParam)) {
      violations.push({
        field: 'limit',
        code: 'invalid',
        message: 'limit must be a plain integer.',
      });
    } else {
      const parsed = Number(input.limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        violations.push({
          field: 'limit',
          code: 'out-of-range',
          message: 'limit must be between 1 and 200.',
        });
      } else {
        limit = parsed;
      }
    }
  }

  let cursor: Cursor | undefined;
  if (input.cursorParam !== undefined) {
    cursor = decodeCursor(input.cursorParam, input.expectedWorkspaceId);
    if (cursor === undefined) {
      violations.push({
        field: 'cursor',
        code: 'invalid',
        message: 'cursor is not a valid opaque cursor.',
      });
    }
  }

  return {
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    violations: Object.freeze(violations),
  };
}
