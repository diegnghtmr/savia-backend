import type { Cursor, PageInfo } from '../platform/cursor.js';

export const ACCOUNTS_PORT = Symbol('AccountsPort');

export const ACCOUNT_TYPE = {
  CASH: 'cash',
  SAVINGS: 'savings',
  CHECKING: 'checking',
  DIGITAL_WALLET: 'digital_wallet',
  CREDIT_CARD: 'credit_card',
  LOAN: 'loan',
  INVESTMENT_MANUAL: 'investment_manual',
  RECEIVABLE: 'receivable',
  GENERIC: 'generic',
} as const;
export type AccountType = (typeof ACCOUNT_TYPE)[keyof typeof ACCOUNT_TYPE];

export const ACCOUNT_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  CLOSED: 'closed',
} as const;
export type AccountStatus =
  (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

const ACCOUNT_STATUS_VALUES: readonly string[] = Object.values(ACCOUNT_STATUS);

export function isAccountStatus(value: string): value is AccountStatus {
  return ACCOUNT_STATUS_VALUES.includes(value);
}

export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface CreateAccountCommand {
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly openingBalance?: Money | null;
  readonly openingBalanceDate?: string | null;
  readonly institution?: string | null;
  readonly maskedNumber?: string | null;
  readonly description?: string | null;
  readonly includeInNetWorth: boolean;
}

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly status: AccountStatus;
  readonly institution: string | null;
  readonly maskedNumber: string | null;
  readonly description: string | null;
  readonly colorToken: string | null;
  readonly icon: string | null;
  readonly includeInNetWorth: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export type { PageInfo };

export interface AccountPage {
  readonly items: readonly Account[];
  readonly pageInfo: PageInfo;
}

export const ACCOUNT_LIST_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
} as const;
export type AccountListOutcomeKind =
  (typeof ACCOUNT_LIST_OUTCOMES)[keyof typeof ACCOUNT_LIST_OUTCOMES];

export interface AccountListOk {
  readonly kind: typeof ACCOUNT_LIST_OUTCOMES.OK;
  readonly page: AccountPage;
}
export interface AccountListForbidden {
  readonly kind: typeof ACCOUNT_LIST_OUTCOMES.FORBIDDEN;
}
// There is no not-found outcome and there must never be one: the authority
// declares 200, 401 and 403 on listAccounts and nothing else, so an absent
// workspace collapses into forbidden to avoid leaking existence.
export type AccountListOutcome = AccountListOk | AccountListForbidden;

export type AccountCursor = Cursor;

export interface AccountListQuery {
  readonly workspaceId: string;
  readonly cursor?: AccountCursor;
  readonly limit: number;
  readonly status?: AccountStatus;
}

export const ACCOUNT_READ_OUTCOMES = {
  OK: 'ok',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
} as const;
export type AccountReadOutcomeKind =
  (typeof ACCOUNT_READ_OUTCOMES)[keyof typeof ACCOUNT_READ_OUTCOMES];

export interface AccountReadOk {
  readonly kind: typeof ACCOUNT_READ_OUTCOMES.OK;
  readonly account: Account;
}
export interface AccountReadForbidden {
  readonly kind: typeof ACCOUNT_READ_OUTCOMES.FORBIDDEN;
}
export interface AccountReadNotFound {
  readonly kind: typeof ACCOUNT_READ_OUTCOMES.NOT_FOUND;
}
// getAccount declares 200, 401, 403 and 404 in the authority:
// - 403 when the caller has no active role in the workspace (or workspace is absent)
// - 404 when the account does not exist or belongs to another workspace (scoped SQL predicate)
export type AccountReadOutcome =
  | AccountReadOk
  | AccountReadForbidden
  | AccountReadNotFound;

export const ACCOUNT_CREATE_OUTCOMES = {
  CREATED: 'created',
  REPLAYED: 'replayed',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  FORBIDDEN: 'forbidden',
} as const;
export type AccountCreateOutcomeKind =
  (typeof ACCOUNT_CREATE_OUTCOMES)[keyof typeof ACCOUNT_CREATE_OUTCOMES];

export interface AccountCreateCreated {
  readonly kind: typeof ACCOUNT_CREATE_OUTCOMES.CREATED;
  readonly account: Account;
}
export interface AccountCreateReplayed {
  readonly kind: typeof ACCOUNT_CREATE_OUTCOMES.REPLAYED;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}
export interface AccountCreateIdempotencyConflict {
  readonly kind: typeof ACCOUNT_CREATE_OUTCOMES.IDEMPOTENCY_CONFLICT;
}
export interface AccountCreateForbidden {
  readonly kind: typeof ACCOUNT_CREATE_OUTCOMES.FORBIDDEN;
}
export type AccountCreateOutcome =
  | AccountCreateCreated
  | AccountCreateReplayed
  | AccountCreateIdempotencyConflict
  | AccountCreateForbidden;

export interface AccountsPort {
  list(subject: string, query: AccountListQuery): Promise<AccountListOutcome>;
  read(
    subject: string,
    workspaceId: string,
    accountId: string,
  ): Promise<AccountReadOutcome>;
  create(
    subject: string,
    workspaceId: string,
    command: CreateAccountCommand,
    idempotencyKey: string,
  ): Promise<AccountCreateOutcome>;
}
