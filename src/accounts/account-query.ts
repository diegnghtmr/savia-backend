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

export interface AccountBalanceQueryInput {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly asOfParam?: string;
}

export interface AccountBalanceQuery {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly asOf?: string;
}

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function createAccountBalanceQuery(
  input: AccountBalanceQueryInput,
): AccountBalanceQuery {
  const violations: FieldViolation[] = [];

  let asOf: string | undefined;
  if (input.asOfParam !== undefined) {
    const trimmed = input.asOfParam.trim();
    if (!trimmed || !ISO_DATE_TIME_PATTERN.test(trimmed)) {
      violations.push(
        Object.freeze({
          field: 'asOf',
          code: 'invalid',
          message: 'asOf must be a valid ISO 8601 date-time string.',
        }),
      );
    } else {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        violations.push(
          Object.freeze({
            field: 'asOf',
            code: 'invalid',
            message: 'asOf must be a valid ISO 8601 date-time string.',
          }),
        );
      } else {
        asOf = trimmed;
      }
    }
  }

  if (violations.length > 0) {
    throw new AccountQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    ...(asOf !== undefined ? { asOf } : {}),
  };
}
