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
export interface UpdateBudgetRequest {
  readonly name?: string;
  readonly method?: BudgetMethod;
}
export interface BudgetAllocationRequest {
  readonly categoryId: string;
  readonly planned: Money;
  readonly rolloverPolicy: RolloverPolicy;
  readonly rolloverTargetId?: string | null;
}
export interface UpdateBudgetAllocationsRequest {
  readonly allocations: readonly BudgetAllocationRequest[];
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
  updateBudget(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    command: UpdateBudgetRequest,
    expectedVersion?: number,
  ): Promise<Budget | undefined>;
  findMissingAllocationReferences(
    client: TransactionClient,
    workspaceId: string,
    allocations: readonly BudgetAllocationRequest[],
  ): Promise<readonly string[]>;
  replaceBudgetAllocations(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    allocations: readonly BudgetAllocationRequest[],
    expectedVersion?: number,
  ): Promise<Budget | undefined>;
  listBudgets(
    client: TransactionClient,
    query: BudgetListQuery,
    limit: number,
  ): Promise<readonly BudgetItem[]>;
}
export const BUDGET_OUTCOMES = {
  CREATED: 'created',
  UPDATED: 'updated',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  INVALID_SOURCE: 'invalid-source',
  FOUND: 'found',
  NOT_FOUND: 'not-found',
  PRECONDITION_FAILED: 'precondition-failed',
  CURRENCY_UNSUPPORTED: 'currency_unsupported',
  INVALID_ALLOCATIONS: 'invalid-allocations',
  TOO_MANY_ALLOCATIONS: 'too-many-allocations',
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
export type BudgetUpdateOutcome =
  | { readonly kind: typeof BUDGET_OUTCOMES.UPDATED; readonly budget: Budget }
  | {
      readonly kind: typeof BUDGET_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof BUDGET_OUTCOMES.FORBIDDEN
        | typeof BUDGET_OUTCOMES.NOT_FOUND
        | typeof BUDGET_OUTCOMES.PRECONDITION_FAILED
        | typeof BUDGET_OUTCOMES.CONFLICT;
    };
export type BudgetAllocationsOutcome =
  | { readonly kind: typeof BUDGET_OUTCOMES.UPDATED; readonly budget: Budget }
  | {
      readonly kind: typeof BUDGET_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof BUDGET_OUTCOMES.FORBIDDEN
        | typeof BUDGET_OUTCOMES.NOT_FOUND
        | typeof BUDGET_OUTCOMES.PRECONDITION_FAILED
        | typeof BUDGET_OUTCOMES.CONFLICT
        | typeof BUDGET_OUTCOMES.INVALID_ALLOCATIONS
        | typeof BUDGET_OUTCOMES.TOO_MANY_ALLOCATIONS;
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
  updateBudget(
    subject: string,
    workspaceId: string,
    id: string,
    command: UpdateBudgetRequest,
    key: string,
    ifMatch: import('../platform/if-match.js').IfMatchParse,
  ): Promise<BudgetUpdateOutcome>;
  updateBudgetAllocations(
    subject: string,
    workspaceId: string,
    id: string,
    command: UpdateBudgetAllocationsRequest,
    key: string,
    ifMatch: import('../platform/if-match.js').IfMatchParse,
  ): Promise<BudgetAllocationsOutcome>;
  listBudgets(
    subject: string,
    query: BudgetListQuery,
  ): Promise<BudgetListOutcome>;
}
