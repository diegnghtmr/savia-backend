import type { PageInfo } from '../platform/cursor.js';
import type { Cursor } from '../platform/cursor.js';

export const CATALOGS_PORT = Symbol('CatalogsPort');

export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface Payee {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

export type CategoryKind = 'income' | 'expense' | 'transfer' | 'other';
export const CATEGORY_KINDS: readonly CategoryKind[] = [
  'income',
  'expense',
  'transfer',
  'other',
] as const;

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
  readonly parentId: string | null;
  readonly kind: CategoryKind;
  readonly icon: string | null;
  readonly colorToken: string | null;
}

export interface CreateNamedResourceCommand {
  readonly name: string;
}
export type CreateTagCommand = CreateNamedResourceCommand;
export type CreatePayeeCommand = CreateNamedResourceCommand;

export interface CreateCategoryCommand {
  readonly name: string;
  readonly kind: CategoryKind;
  readonly parentId: string | null;
  readonly icon: string | null;
  readonly colorToken: string | null;
}

export const CATALOG_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  PARENT_NOT_FOUND: 'parent_not_found',
} as const;

export type CatalogCreateOutcomeKind =
  (typeof CATALOG_CREATE_OUTCOMES)[keyof typeof CATALOG_CREATE_OUTCOMES];

export interface TagCreateCreated {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.CREATED;
  readonly tag: Tag;
}

export interface PayeeCreateCreated {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.CREATED;
  readonly payee: Payee;
}

export interface CategoryCreateCreated {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.CREATED;
  readonly category: Category;
}

export interface CategoryCreateParentNotFound {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.PARENT_NOT_FOUND;
}

export interface CatalogCreateReplayed {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

export interface CatalogCreateIdempotencyConflict {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}

export interface CatalogCreateForbidden {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.FORBIDDEN;
}

export interface CatalogCreateConflict {
  readonly kind: typeof CATALOG_CREATE_OUTCOMES.CONFLICT;
}

export type TagCreateOutcome =
  | TagCreateCreated
  | CatalogCreateReplayed
  | CatalogCreateIdempotencyConflict
  | CatalogCreateForbidden
  | CatalogCreateConflict;

export type PayeeCreateOutcome =
  | PayeeCreateCreated
  | CatalogCreateReplayed
  | CatalogCreateIdempotencyConflict
  | CatalogCreateForbidden
  | CatalogCreateConflict;

export type CategoryCreateOutcome =
  | CategoryCreateCreated
  | CatalogCreateReplayed
  | CatalogCreateIdempotencyConflict
  | CatalogCreateForbidden
  | CatalogCreateConflict
  | CategoryCreateParentNotFound;

export interface CatalogListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}
export type TagListQuery = CatalogListQuery;
export type PayeeListQuery = CatalogListQuery;
export type CategoryListQuery = CatalogListQuery;

export const CATALOG_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
} as const;

export type CatalogListOutcomeKind =
  (typeof CATALOG_LIST_OUTCOMES)[keyof typeof CATALOG_LIST_OUTCOMES];

export interface TagPage {
  readonly items: readonly Tag[];
  readonly pageInfo: PageInfo;
}

export interface PayeePage {
  readonly items: readonly Payee[];
  readonly pageInfo: PageInfo;
}

export interface CategoryPage {
  readonly items: readonly Category[];
  readonly pageInfo: PageInfo;
}

export interface TagListOk {
  readonly kind: typeof CATALOG_LIST_OUTCOMES.OK;
  readonly page: TagPage;
}

export interface PayeeListOk {
  readonly kind: typeof CATALOG_LIST_OUTCOMES.OK;
  readonly page: PayeePage;
}

export interface CategoryListOk {
  readonly kind: typeof CATALOG_LIST_OUTCOMES.OK;
  readonly page: CategoryPage;
}

export interface CatalogListForbidden {
  readonly kind: typeof CATALOG_LIST_OUTCOMES.FORBIDDEN;
}

export type TagListOutcome = TagListOk | CatalogListForbidden;
export type PayeeListOutcome = PayeeListOk | CatalogListForbidden;
export type CategoryListOutcome = CategoryListOk | CatalogListForbidden;

export interface CatalogsPort {
  createTag(
    subject: string,
    workspaceId: string,
    command: CreateTagCommand,
    idempotencyKey: string,
  ): Promise<TagCreateOutcome>;

  listTags(subject: string, query: TagListQuery): Promise<TagListOutcome>;

  createPayee(
    subject: string,
    workspaceId: string,
    command: CreatePayeeCommand,
    idempotencyKey: string,
  ): Promise<PayeeCreateOutcome>;

  listPayees(subject: string, query: PayeeListQuery): Promise<PayeeListOutcome>;

  createCategory(
    subject: string,
    workspaceId: string,
    command: CreateCategoryCommand,
    idempotencyKey: string,
  ): Promise<CategoryCreateOutcome>;

  listCategories(
    subject: string,
    query: CategoryListQuery,
  ): Promise<CategoryListOutcome>;
}
