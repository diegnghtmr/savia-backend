import type { FieldViolation } from '../platform/problem-details.js';
import { parseListQuery, DEFAULT_LIST_LIMIT } from '../platform/list-query.js';
import {
  isAccountStatus,
  type AccountListQuery,
  type AccountStatus,
} from './accounts.port.js';

export const ACCOUNT_LIST_DEFAULT_LIMIT = DEFAULT_LIST_LIMIT;

export class AccountQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Account list query validation failed.');
    this.name = 'AccountQueryValidationError';
  }
}

export interface AccountListQueryInput {
  readonly workspaceId: string;
  readonly cursorParam?: string;
  readonly limitParam?: string;
  readonly statusParam?: string;
}

export function createAccountListQuery(
  input: AccountListQueryInput,
): AccountListQuery {
  const base = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
  });
  const violations: FieldViolation[] = [...base.violations];

  let status: AccountStatus | undefined;
  if (input.statusParam !== undefined) {
    if (!isAccountStatus(input.statusParam)) {
      violations.push(
        Object.freeze({
          field: 'status',
          code: 'invalid',
          message: 'status must be one of active, archived, closed.',
        }),
      );
    } else {
      status = input.statusParam;
    }
  }

  if (violations.length > 0) {
    throw new AccountQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    ...(base.cursor === undefined ? {} : { cursor: base.cursor }),
    limit: base.limit,
    ...(status === undefined ? {} : { status }),
  };
}
