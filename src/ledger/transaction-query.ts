import type { FieldViolation } from '../platform/problem-details.js';
import { parseListQuery, DEFAULT_LIST_LIMIT } from '../platform/list-query.js';
import { UUID_PATTERN } from '../platform/uuid.js';
import {
  isTransactionStatus,
  type TransactionListQuery,
  type TransactionStatus,
} from './ledger.port.js';

export const TRANSACTION_LIST_DEFAULT_LIMIT = DEFAULT_LIST_LIMIT;

export class TransactionQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Transaction list query validation failed.');
    this.name = 'TransactionQueryValidationError';
  }
}

export interface TransactionListQueryInput {
  readonly workspaceId: string;
  readonly cursorParam?: string;
  readonly limitParam?: string;
  readonly accountIdParam?: string;
  readonly fromParam?: string;
  readonly toParam?: string;
  readonly categoryIdParam?: string;
  readonly statusParam?: string;
  readonly queryParam?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(dateStr: string): boolean {
  if (!DATE_PATTERN.test(dateStr)) {
    return false;
  }
  const parsedDate = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime())) {
    return false;
  }
  return parsedDate.toISOString().slice(0, 10) === dateStr;
}

export function createTransactionListQuery(
  input: TransactionListQueryInput,
): TransactionListQuery {
  const base = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
  });
  const violations: FieldViolation[] = [...base.violations];

  let accountId: string | undefined;
  if (input.accountIdParam !== undefined) {
    if (!UUID_PATTERN.test(input.accountIdParam)) {
      violations.push(
        Object.freeze({
          field: 'accountId',
          code: 'invalid',
          message: 'accountId must be a valid UUID.',
        }),
      );
    } else {
      accountId = input.accountIdParam;
    }
  }

  let from: string | undefined;
  if (input.fromParam !== undefined) {
    if (!isValidDate(input.fromParam)) {
      violations.push(
        Object.freeze({
          field: 'from',
          code: 'invalid',
          message: 'from must be a valid ISO 8601 date (YYYY-MM-DD).',
        }),
      );
    } else {
      from = input.fromParam;
    }
  }

  let to: string | undefined;
  if (input.toParam !== undefined) {
    if (!isValidDate(input.toParam)) {
      violations.push(
        Object.freeze({
          field: 'to',
          code: 'invalid',
          message: 'to must be a valid ISO 8601 date (YYYY-MM-DD).',
        }),
      );
    } else {
      to = input.toParam;
    }
  }

  let categoryId: string | undefined;
  if (input.categoryIdParam !== undefined) {
    if (!UUID_PATTERN.test(input.categoryIdParam)) {
      violations.push(
        Object.freeze({
          field: 'categoryId',
          code: 'invalid',
          message: 'categoryId must be a valid UUID.',
        }),
      );
    } else {
      categoryId = input.categoryIdParam;
    }
  }

  let status: TransactionStatus | undefined;
  if (input.statusParam !== undefined) {
    if (!isTransactionStatus(input.statusParam)) {
      violations.push(
        Object.freeze({
          field: 'status',
          code: 'invalid',
          message:
            'status must be one of draft, pending, confirmed, reconciled, voided.',
        }),
      );
    } else {
      status = input.statusParam;
    }
  }

  let query: string | undefined;
  if (input.queryParam !== undefined) {
    if (input.queryParam.length > 200) {
      violations.push(
        Object.freeze({
          field: 'query',
          code: 'out-of-range',
          message: 'query must not exceed 200 characters.',
        }),
      );
    } else {
      query = input.queryParam;
    }
  }

  if (violations.length > 0) {
    throw new TransactionQueryValidationError(Object.freeze(violations));
  }

  return {
    workspaceId: input.workspaceId,
    ...(base.cursor === undefined ? {} : { cursor: base.cursor }),
    limit: base.limit,
    ...(accountId === undefined ? {} : { accountId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(status === undefined ? {} : { status }),
    ...(query === undefined ? {} : { query }),
  };
}
