import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const BUDGETS_PORT = Symbol('BudgetsPort');
export const BUDGET_METHODS = {
  CASH_FLOW: 'cash_flow',
  ZERO_BASED: 'zero_based',
  ENVELOPE: 'envelope',
  HYBRID: 'hybrid',
} as const;
export type BudgetMethod = (typeof BUDGET_METHODS)[keyof typeof BUDGET_METHODS];
export const ROLLOVER_POLICIES = {
  NONE: 'none',
  SURPLUS: 'surplus',
  DEFICIT: 'deficit',
  BOTH: 'both',
  TO_SAVINGS: 'to_savings',
  TO_FUND: 'to_fund',
  TO_CATEGORY: 'to_category',
} as const;
export type RolloverPolicy =
  (typeof ROLLOVER_POLICIES)[keyof typeof ROLLOVER_POLICIES];
export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}
export interface BudgetAllocation {
  readonly categoryId: string;
  readonly planned: Money;
  readonly actual: Money;
  readonly available: Money;
  readonly rolloverPolicy: RolloverPolicy;
  readonly rolloverTargetId?: string | null;
}
export interface Budget {
  readonly id: string;
  readonly name: string;
  readonly method: BudgetMethod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly allocations: readonly BudgetAllocation[];
  readonly version: number;
}
export interface CreateBudgetRequest {
  readonly name: string;
  readonly method: BudgetMethod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly copyFromBudgetId?: string | null;
}
export interface BudgetListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
  readonly from?: string;
  readonly to?: string;
}
export interface BudgetItem {
  readonly budget: Budget;
  readonly cursorAt: string;
}
export interface BudgetStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  readWorkspaceCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createBudget(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateBudgetRequest,
    currency: string,
  ): Promise<Budget>;
  findBudget(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Budget | undefined>;
  findSourceAllocations(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<readonly BudgetAllocation[]>;
  insertCopiedAllocations(
    client: TransactionClient,
    workspaceId: string,
    budgetId: string,
    allocations: readonly BudgetAllocation[],
  ): Promise<void>;
  listBudgets(
    client: TransactionClient,
    query: BudgetListQuery,
    limit: number,
  ): Promise<readonly BudgetItem[]>;
}
export const BUDGET_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  INVALID_SOURCE: 'invalid-source',
  TOO_MANY_ALLOCATIONS: 'too-many-allocations',
  FOUND: 'found',
  NOT_FOUND: 'not-found',
  CURRENCY_UNSUPPORTED: 'currency_unsupported',
} as const;
export type BudgetCreateOutcome =
  | { readonly kind: typeof BUDGET_OUTCOMES.CREATED; readonly budget: Budget }
  | {
      readonly kind: typeof BUDGET_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof BUDGET_OUTCOMES.FORBIDDEN
        | typeof BUDGET_OUTCOMES.CONFLICT
        | typeof BUDGET_OUTCOMES.INVALID_SOURCE
        | typeof BUDGET_OUTCOMES.TOO_MANY_ALLOCATIONS
        | typeof BUDGET_OUTCOMES.CURRENCY_UNSUPPORTED;
    };
export type BudgetGetOutcome =
  | { readonly kind: typeof BUDGET_OUTCOMES.FOUND; readonly budget: Budget }
  | {
      readonly kind:
        | typeof BUDGET_OUTCOMES.NOT_FOUND
        | typeof BUDGET_OUTCOMES.FORBIDDEN;
    };
export type BudgetListOutcome =
  | {
      readonly kind: 'ok';
      readonly page: {
        readonly items: readonly Budget[];
        readonly pageInfo: PageInfo;
      };
    }
  | { readonly kind: typeof BUDGET_OUTCOMES.FORBIDDEN };
export interface BudgetsPort {
  createBudget(
    subject: string,
    workspaceId: string,
    command: CreateBudgetRequest,
    key: string,
  ): Promise<BudgetCreateOutcome>;
  getBudget(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<BudgetGetOutcome>;
  listBudgets(
    subject: string,
    query: BudgetListQuery,
  ): Promise<BudgetListOutcome>;
}
