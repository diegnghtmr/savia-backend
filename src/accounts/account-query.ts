import type { FieldViolation } from '../identity/bootstrap-command.js';
import {
  decodeAccountCursor,
  isAccountStatus,
  type AccountListQuery,
  type AccountStatus,
} from './accounts.port.js';

export const ACCOUNT_LIST_DEFAULT_LIMIT = 50;
const LIMIT_PATTERN = /^\d+$/;

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
  const violations: FieldViolation[] = [];

  let limit = ACCOUNT_LIST_DEFAULT_LIMIT;
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

  let cursor: AccountListQuery['cursor'];
  if (input.cursorParam !== undefined) {
    cursor = decodeAccountCursor(input.cursorParam);
    if (cursor === undefined) {
      violations.push({
        field: 'cursor',
        code: 'invalid',
        message: 'cursor is not a valid opaque cursor.',
      });
    }
  }

  let status: AccountStatus | undefined;
  if (input.statusParam !== undefined) {
    if (!isAccountStatus(input.statusParam)) {
      violations.push({
        field: 'status',
        code: 'invalid',
        message: 'status must be one of active, archived, closed.',
      });
    } else {
      status = input.statusParam;
    }
  }

  if (violations.length > 0) {
    throw new AccountQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    ...(cursor === undefined ? {} : { cursor }),
    limit,
    ...(status === undefined ? {} : { status }),
  };
}
