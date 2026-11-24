import type { Cursor, PageInfo } from '../platform/cursor.js';
import type { TransactionClient } from '../platform/pg-transaction.js';

export const FUNDS_PORT = Symbol('FundsPort');

export const FUND_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const;
export type FundStatus = (typeof FUND_STATUS)[keyof typeof FUND_STATUS];

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface Fund {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly targetAmount: Money;
  readonly currentAmount: Money;
  readonly targetDate?: string | null;
  readonly linkedAccountId?: string | null;
  readonly recommendedMonthlyContribution?: Money;
  readonly status: FundStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FundDetail = Omit<Fund, 'version' | 'createdAt' | 'updatedAt'> & {
  readonly objective: string | null;
  readonly responsibleMemberIds: readonly string[];
  readonly etag: string;
};

export interface UpdateFundRequest {
  readonly name?: string;
  readonly objective?: string | null;
  readonly targetAmount?: Money;
  readonly targetDate?: string | null;
  readonly linkedAccountId?: string | null;
  readonly responsibleMemberIds?: readonly string[];
}

export interface CreateFundWithdrawalRequest {
  readonly accountId: string;
  readonly amount: Money;
  readonly reason: string;
}

export interface FundTransaction {
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

export interface CreateFundRequest {
  readonly name: string;
  readonly currency: string;
  readonly targetAmount: Money;
  readonly targetDate?: string | null;
  readonly linkedAccountId?: string | null;
}

export interface CreateFundContributionRequest {
  readonly accountId: string;
  readonly amount: Money;
  readonly occurredAt: string;
  readonly notes?: string | null;
}

export interface FundListQuery {
  readonly workspaceId: string;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface FundItem {
  readonly fund: Fund;
  readonly cursorAt: string;
}

export interface FundAccountRecord {
  readonly status: string;
  readonly currency: string;
}

export interface FundStore {
  readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined>;
  createFund(
    client: TransactionClient,
    workspaceId: string,
    command: CreateFundRequest,
  ): Promise<Fund>;
  findFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<Fund | undefined>;
  lockFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<void>;
  readFundDetail(
    client: TransactionClient,
    workspaceId: string,
    id: string,
  ): Promise<{ fund: FundDetail; version: number } | undefined>;
  updateFund(
    client: TransactionClient,
    workspaceId: string,
    id: string,
    command: UpdateFundRequest,
    version: number,
  ): Promise<boolean>;
  hasActiveMembers(
    client: TransactionClient,
    workspaceId: string,
    ids: readonly string[],
  ): Promise<boolean>;
  listFunds(
    client: TransactionClient,
    query: FundListQuery,
    limit: number,
  ): Promise<readonly FundItem[]>;
  lockAndReadAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<FundAccountRecord | undefined>;
  contributeToFund(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    fund: Fund,
    command: CreateFundContributionRequest,
  ): Promise<FundTransaction>;
  withdrawFromFund(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    fund: Fund,
    command: CreateFundWithdrawalRequest,
  ): Promise<FundTransaction | undefined>;
}

export const FUND_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  NOT_FOUND: 'not-found',
  ACCOUNT_NOT_FOUND: 'account-not-found',
  ACCOUNT_CLOSED: 'account-closed',
  CURRENCY_MISMATCH: 'currency-mismatch',
  ACCOUNT_CURRENCY_MISMATCH: 'account-currency-mismatch',
  LINKED_ACCOUNT_NOT_FOUND: 'linked-account-not-found',
  INSUFFICIENT_SAVED: 'insufficient-saved',
} as const;

export type FundDetailOutcome =
  | { readonly kind: 'ok'; readonly fund: FundDetail }
  | { readonly kind: 'forbidden' | 'not-found' };

export type FundUpdateOutcome =
  | FundDetailOutcome
  | Extract<FundCreateOutcome, { kind: 'replayed' }>
  | {
      readonly kind:
        | 'stale'
        | 'conflict'
        | 'currency-mismatch'
        | 'linked-account-not-found'
        | 'inactive-members';
    };

export type FundCreateOutcome =
  | { readonly kind: typeof FUND_OUTCOMES.CREATED; readonly fund: Fund }
  | {
      readonly kind: typeof FUND_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof FUND_OUTCOMES.FORBIDDEN
        | typeof FUND_OUTCOMES.CONFLICT
        | typeof FUND_OUTCOMES.LINKED_ACCOUNT_NOT_FOUND;
    };

export type FundListOutcome =
  | {
      readonly kind: 'ok';
      readonly page: {
        readonly items: readonly Fund[];
        readonly pageInfo: PageInfo;
      };
    }
  | { readonly kind: typeof FUND_OUTCOMES.FORBIDDEN };

export type FundMovementOutcome =
  | {
      readonly kind: typeof FUND_OUTCOMES.CREATED;
      readonly transaction: FundTransaction;
    }
  | {
      readonly kind: typeof FUND_OUTCOMES.REPLAYED;
      readonly status: number;
      readonly etag: string | null;
      readonly body: unknown;
    }
  | {
      readonly kind:
        | typeof FUND_OUTCOMES.FORBIDDEN
        | typeof FUND_OUTCOMES.CONFLICT
        | typeof FUND_OUTCOMES.NOT_FOUND
        | typeof FUND_OUTCOMES.ACCOUNT_NOT_FOUND
        | typeof FUND_OUTCOMES.ACCOUNT_CLOSED
        | typeof FUND_OUTCOMES.CURRENCY_MISMATCH
        | typeof FUND_OUTCOMES.ACCOUNT_CURRENCY_MISMATCH
        | typeof FUND_OUTCOMES.INSUFFICIENT_SAVED;
    };

export interface FundsPort {
  getFund(
    subject: string,
    workspaceId: string,
    id: string,
  ): Promise<FundDetailOutcome>;
  updateFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: UpdateFundRequest,
    ifMatch: string,
    key: string,
  ): Promise<FundUpdateOutcome>;
  withdrawFromFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: CreateFundWithdrawalRequest,
    key: string,
  ): Promise<FundMovementOutcome>;
  createFund(
    subject: string,
    workspaceId: string,
    command: CreateFundRequest,
    key: string,
  ): Promise<FundCreateOutcome>;
  listFunds(subject: string, query: FundListQuery): Promise<FundListOutcome>;
  contributeToFund(
    subject: string,
    workspaceId: string,
    fundId: string,
    command: CreateFundContributionRequest,
    key: string,
  ): Promise<FundMovementOutcome>;
}
