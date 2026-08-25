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

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly nextCursor: string | null;
}

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

export interface AccountCursor {
  // Microsecond precision: to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') preserves
  // full timestamptz resolution so keyset comparison and ordering match the
  // raw (workspace_id, created_at, id) index prefix.
  readonly createdAt: string;
  readonly id: string;
}

export interface AccountListQuery {
  readonly workspaceId: string;
  readonly cursor?: AccountCursor;
  readonly limit: number;
  readonly status?: AccountStatus;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_PATTERN =
  /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeAccountCursor(cursor: AccountCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString(
    'base64url',
  );
}

export function decodeAccountCursor(raw: string): AccountCursor | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    !BASE64URL_PATTERN.test(raw)
  ) {
    return undefined;
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || typeof id !== 'string') {
      return undefined;
    }
    // Date.parse alone is insufficient because it accepts instants outside PostgreSQL's
    // timestamptz text-input range (e.g. extended years, year 0000), which would surface
    // as an unhandled 500 from a client-supplied query parameter.
    if (!ISO_TIMESTAMP_PATTERN.test(createdAt)) {
      return undefined;
    }
    const parsedDate = new Date(createdAt);
    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 23) !== createdAt.slice(0, 23)
    ) {
      return undefined;
    }
    if (!UUID_PATTERN.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

export interface AccountsPort {
  list(subject: string, query: AccountListQuery): Promise<AccountListOutcome>;
}
