import type { FieldViolation } from '../platform/problem-details.js';
import { parseListQuery, DEFAULT_LIST_LIMIT } from '../platform/list-query.js';
import type { CatalogListQuery } from './catalogs.port.js';

export const CATALOG_LIST_DEFAULT_LIMIT = DEFAULT_LIST_LIMIT;

export class CatalogQueryValidationError extends Error {
  public constructor(public readonly violations: readonly FieldViolation[]) {
    super('Catalog list query validation failed.');
    this.name = 'CatalogQueryValidationError';
  }
}

export interface CatalogListQueryInput {
  readonly workspaceId: string;
  readonly cursorParam?: string;
  readonly limitParam?: string;
}
export type TagListQueryInput = CatalogListQueryInput;
export type PayeeListQueryInput = CatalogListQueryInput;

export function createCatalogListQuery(
  input: CatalogListQueryInput,
): CatalogListQuery {
  const base = parseListQuery({
    cursorParam: input.cursorParam,
    limitParam: input.limitParam,
    expectedWorkspaceId: input.workspaceId,
  });

  if (base.violations.length > 0) {
    throw new CatalogQueryValidationError(base.violations);
  }

  return {
    workspaceId: input.workspaceId,
    ...(base.cursor === undefined ? {} : { cursor: base.cursor }),
    limit: base.limit,
  };
}

export const createTagListQuery = createCatalogListQuery;
export const createPayeeListQuery = createCatalogListQuery;
