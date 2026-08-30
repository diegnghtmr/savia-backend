import type { FieldViolation } from '../platform/problem-details.js';
import { parseListQuery, DEFAULT_LIST_LIMIT } from '../platform/list-query.js';
import {
  type SubscriptionListQuery,
  type SubscriptionStatus,
  SUBSCRIPTION_STATUSES,
} from './recurring.port.js';

export { SUBSCRIPTION_STATUSES } from './recurring.port.js';

export const SUBSCRIPTION_LIST_DEFAULT_LIMIT = DEFAULT_LIST_LIMIT;

export class SubscriptionQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Subscription list query validation failed.');
    this.name = 'SubscriptionQueryValidationError';
  }
}

export interface SubscriptionListQueryInput {
  readonly workspaceId: string;
  readonly cursorParam?: string;
  readonly limitParam?: string;
  readonly statusParam?: string;
}

/**
 * Parses and validates query parameters for listSubscriptions.
 *
 * RULING 61: An unknown status filter is 400, not silence and not 422.
 * Valid statuses: detected | confirmed | ignored | cancelled.
 * An OMITTED status means no filter and must return every status.
 */
export function createSubscriptionListQuery(
  input: SubscriptionListQueryInput,
): SubscriptionListQuery {
  const violations: FieldViolation[] = [];

  const base = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
    expectedWorkspaceId: input.workspaceId,
  });

  for (const v of base.violations) {
    violations.push(v);
  }

  let status: SubscriptionStatus | undefined;
  if (input.statusParam !== undefined) {
    if (
      !SUBSCRIPTION_STATUSES.includes(input.statusParam as SubscriptionStatus)
    ) {
      violations.push(
        Object.freeze({
          field: 'status',
          code: 'invalid',
          message:
            "status must be one of 'detected', 'confirmed', 'ignored', 'cancelled'.",
        }),
      );
    } else {
      status = input.statusParam as SubscriptionStatus;
    }
  }

  if (violations.length > 0) {
    throw new SubscriptionQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    ...(base.cursor === undefined ? {} : { cursor: base.cursor }),
    limit: base.limit,
    ...(status === undefined ? {} : { status }),
  };
}
