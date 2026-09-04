import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const DEBTS_PORT = Symbol('DebtsPort');

export const DEBT_STATUS = {
  ACTIVE: 'active',
  PAID: 'paid',
  DEFAULTED: 'defaulted',
  ARCHIVED: 'archived',
} as const;
export type DebtStatus = (typeof DEBT_STATUS)[keyof typeof DEBT_STATUS];

export const RATE_TYPE = {
  FIXED: 'fixed',
  VARIABLE: 'variable',
} as const;
export type RateType = (typeof RATE_TYPE)[keyof typeof RATE_TYPE];

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface Debt {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly principal: Money;
  readonly outstandingBalance: Money;
  readonly annualRate: string;
  readonly rateType?: RateType;
  readonly minimumPayment?: Money;
  readonly nextPaymentAt?: string | null;
  readonly status: DebtStatus;
}

export interface DebtTransaction {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly occurredAt: string;
  readonly categoryId: string | null;
  readonly payeeId: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly tagIds: readonly string[];
  readonly receiptId: string | null;
  readonly reconciliationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CreateDebtRequest {
  readonly name: string;
  readonly principal: Money;
  readonly annualRate: string;
  readonly rateType: RateType;
  readonly minimumPayment?: Money;
  readonly startDate?: string | null;
  readonly termMonths?: number | null;
}

export interface CreateDebtPaymentRequest {
  readonly accountId: string;
  readonly totalAmount: Money;
  readonly principalAmount?: Money;
  readonly interestAmount?: Money;
  readonly feeAmount?: Money;
  readonly occurredAt: string;
}

export interface DebtListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface DebtItem {
  readonly debt: Debt;
  readonly cursorAt: string;
}

export interface DebtAccountRecord {
  readonly status: string;
  readonly currency: string;
}

export interface DebtStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createDebt(
    client: TransactionClient,
    workspaceId: string,
    command: CreateDebtRequest,
  ): Promise<Debt>;
  findDebt(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Debt | undefined>;
  listDebts(
    client: TransactionClient,
    query: DebtListQuery,
    limit: number,
  ): Promise<readonly DebtItem[]>;
  lockAndReadAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<DebtAccountRecord | undefined>;
  createDebtPayment(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    debt: Debt,
    command: CreateDebtPaymentRequest,
  ): Promise<DebtTransaction>;
}

export const DEBT_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  NOT_FOUND: 'not-found',
  ACCOUNT_NOT_FOUND: 'account-not-found',
  ACCOUNT_CLOSED: 'account-closed',
  CURRENCY_MISMATCH: 'currency-mismatch',
  ACCOUNT_CURRENCY_MISMATCH: 'account-currency-mismatch',
} as const;

export type DebtCreateOutcome =
  | { readonly kind: typeof DEBT_OUTCOMES.CREATED; readonly debt: Debt }
  | {
      readonly kind: typeof DEBT_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof DEBT_OUTCOMES.FORBIDDEN
        | typeof DEBT_OUTCOMES.CONFLICT;
    };

export type DebtListOutcome =
  | {
      readonly kind: 'ok';
      readonly page: {
        readonly items: readonly Debt[];
        readonly pageInfo: PageInfo;
      };
    }
  | { readonly kind: typeof DEBT_OUTCOMES.FORBIDDEN };

export type DebtPaymentOutcome =
  | {
      readonly kind: typeof DEBT_OUTCOMES.CREATED;
      readonly transaction: DebtTransaction;
    }
  | {
      readonly kind: typeof DEBT_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof DEBT_OUTCOMES.FORBIDDEN
        | typeof DEBT_OUTCOMES.CONFLICT
        | typeof DEBT_OUTCOMES.NOT_FOUND
        | typeof DEBT_OUTCOMES.ACCOUNT_NOT_FOUND
        | typeof DEBT_OUTCOMES.ACCOUNT_CLOSED
        | typeof DEBT_OUTCOMES.CURRENCY_MISMATCH
        | typeof DEBT_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH;
    };

export interface DebtsPort {
  createDebt(
    subject: string,
    workspaceId: string,
    command: CreateDebtRequest,
    key: string,
  ): Promise<DebtCreateOutcome>;
  listDebts(subject: string, query: DebtListQuery): Promise<DebtListOutcome>;
  createDebtPayment(
    subject: string,
    workspaceId: string,
    debtId: string,
    command: CreateDebtPaymentRequest,
    key: string,
  ): Promise<DebtPaymentOutcome>;
}
