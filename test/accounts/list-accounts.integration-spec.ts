import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_LIST_OUTCOMES,
  type Account,
} from '../../src/accounts/accounts.port.js';
import { decodeCursor } from '../../src/platform/cursor.js';
import { AccountsService } from '../../src/accounts/accounts.service.js';
import { PostgresAccountsAdapter } from '../../src/accounts/postgres-accounts.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const accountId = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

// Microsecond precision seeds: rows differ in microseconds within the same
// millisecond bucket, and rows 1002/1003 share the exact same microsecond
// timestamp (.000200), exercising both microsecond ordering and UUID tie-breaking.
const MICROSECOND_SEEDS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly type: Account['type'];
  readonly status: Account['status'];
  readonly createdAt: string;
}> = [
  {
    id: accountId(1006),
    name: 'Loan',
    type: 'loan',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000500+00',
  },
  {
    id: accountId(1001),
    name: 'Cash wallet',
    type: 'cash',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000100+00',
  },
  {
    id: accountId(1002),
    name: 'Savings',
    type: 'savings',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000200+00',
  },
  {
    id: accountId(1003),
    name: 'Generic',
    type: 'generic',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000200+00',
  },
  {
    id: accountId(1004),
    name: 'Checking',
    type: 'checking',
    status: 'archived',
    createdAt: '2026-07-01T00:00:00.000300+00',
  },
  {
    id: accountId(1005),
    name: 'Credit card',
    type: 'credit_card',
    status: 'closed',
    createdAt: '2026-07-01T00:00:00.000400+00',
  },
];

describe('AccountsService listAccounts database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let service: AccountsService;

  const subjectOwner = subject(900);
  const subjectViewer = subject(901);
  const subjectNonMember = subject(902);
  const subjectEmptyWorkspaceMember = subject(903);

  const workspaceWithAccountsId = accountId(951);
  const emptyWorkspaceId = accountId(952);

  // Expected global order under (created_at, id).
  const expectedOrder = [
    accountId(1006),
    accountId(1001),
    accountId(1002),
    accountId(1003),
    accountId(1004),
    accountId(1005),
  ];

  async function listIds(
    subjectId: string,
    workspaceId: string,
    options: {
      readonly limit?: number;
      readonly status?: Account['status'];
    } = {},
  ): Promise<
    | {
        readonly kind: typeof ACCOUNT_LIST_OUTCOMES.OK;
        readonly ids: readonly string[];
      }
    | { readonly kind: typeof ACCOUNT_LIST_OUTCOMES.FORBIDDEN }
  > {
    const outcome = await service.list(subjectId, {
      workspaceId,
      limit: options.limit ?? 50,
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    if (outcome.kind === ACCOUNT_LIST_OUTCOMES.FORBIDDEN) return outcome;
    return {
      kind: outcome.kind,
      ids: outcome.page.items.map((item) => item.id),
    };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    service = new AccountsService(
      transaction,
      new PostgresAccountsAdapter(),
      new PostgresIdempotencyAdapter(),
    );

    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
      [
        subjectOwner,
        'accounts-owner@example.test',
        subjectViewer,
        'accounts-viewer@example.test',
        subjectNonMember,
        'accounts-nonmember@example.test',
        subjectEmptyWorkspaceMember,
        'accounts-empty@example.test',
      ],
    );

    for (const [id, email, name] of [
      [subjectOwner, 'accounts-owner@example.test', 'Accounts Owner'],
      [subjectViewer, 'accounts-viewer@example.test', 'Accounts Viewer'],
      [
        subjectNonMember,
        'accounts-nonmember@example.test',
        'Accounts Non Member',
      ],
      [
        subjectEmptyWorkspaceMember,
        'accounts-empty@example.test',
        'Accounts Empty Workspace Member',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [id, email, name],
      );
    }

    for (const [id, name] of [
      [workspaceWithAccountsId, 'Accounts Workspace'],
      [emptyWorkspaceId, 'Empty Workspace'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [id, name],
      );
    }

    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'viewer', 'active'),
              ($4, $5, 'viewer', 'active')`,
      [
        workspaceWithAccountsId,
        subjectOwner,
        subjectViewer,
        emptyWorkspaceId,
        subjectEmptyWorkspaceMember,
      ],
    );

    for (const seed of MICROSECOND_SEEDS) {
      const closedAt =
        seed.status === 'closed' ? '2026-08-01T00:00:00+00' : null;
      await admin.query(
        `insert into public.accounts
           (id, workspace_id, name, type, currency, status, institution, masked_number,
            description, color_token, icon, include_in_net_worth, created_by, created_at, updated_at, closed_at)
         values ($1, $2, $3, $4, 'USD', $5, $6, $7, $8, $9, $10, true, $11, $12::timestamptz, $12::timestamptz, $13::timestamptz)`,
        [
          seed.id,
          workspaceWithAccountsId,
          seed.name,
          seed.type,
          seed.status,
          seed.id === accountId(1005) ? 'Acme Bank' : null,
          seed.id === accountId(1005) ? '**** 1234' : null,
          seed.id === accountId(1005) ? 'Everyday card' : null,
          seed.id === accountId(1005) ? '#112233' : null,
          seed.id === accountId(1005) ? 'card' : null,
          subjectOwner,
          seed.createdAt,
          closedAt,
        ],
      );
    }
  });

  afterAll(async () => {
    await admin.end();
    await transaction.close();
  });

  it('lists nothing without membership instead of an empty page', async () => {
    const outcome = await listIds(subjectNonMember, workspaceWithAccountsId);
    expect(outcome.kind).toBe(ACCOUNT_LIST_OUTCOMES.FORBIDDEN);
    if (outcome.kind === ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error(
        `non-member got an HTTP-ok empty page (${outcome.ids.length} items); refusal required`,
      );
    }
  });

  it('refuses a workspace that does not exist for the same reason there is no 404', async () => {
    const outcome = await listIds(subjectOwner, accountId(999999));
    expect(outcome.kind).toBe(ACCOUNT_LIST_OUTCOMES.FORBIDDEN);
  });

  it('lets a viewer list because the select policy admits all four roles', async () => {
    const outcome = await listIds(subjectViewer, workspaceWithAccountsId);
    if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.ids).toEqual(expectedOrder);
  });

  it('returns a genuinely empty page to a member of a workspace without accounts', async () => {
    const outcome = await listIds(
      subjectEmptyWorkspaceMember,
      emptyWorkspaceId,
    );
    expect(outcome).toEqual({
      kind: ACCOUNT_LIST_OUTCOMES.OK,
      ids: [],
    });
  });

  it('walks microsecond-spaced rows with limit 1 without repeating or dropping any', async () => {
    let cursor: Parameters<AccountsService['list']>[1]['cursor'] = undefined;
    const walked: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const outcome = await service.list(subjectOwner, {
        workspaceId: workspaceWithAccountsId,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
        throw new Error(`expected ok, got ${outcome.kind}`);
      }
      walked.push(...outcome.page.items.map((item) => item.id));
      if (!outcome.page.pageInfo.hasNextPage) break;
      const nextCursor = outcome.page.pageInfo.nextCursor;
      if (nextCursor === null) {
        throw new Error('hasNextPage true but nextCursor null');
      }
      expect(decodeCursor(nextCursor)).toBeDefined();
      cursor = decodeCursor(nextCursor);
    }
    expect(walked).toEqual(expectedOrder);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('honours small and large limits', async () => {
    const limited = await listIds(subjectOwner, workspaceWithAccountsId, {
      limit: 2,
    });
    if (limited.kind !== ACCOUNT_LIST_OUTCOMES.OK)
      throw new Error('expected ok');
    expect(limited.ids).toEqual(expectedOrder.slice(0, 2));

    const wide = await listIds(subjectOwner, workspaceWithAccountsId, {
      limit: 200,
    });
    if (wide.kind !== ACCOUNT_LIST_OUTCOMES.OK) throw new Error('expected ok');
    expect(wide.ids).toEqual(expectedOrder);
  });

  it('filters by status', async () => {
    const archived = await listIds(subjectOwner, workspaceWithAccountsId, {
      status: 'archived',
    });
    expect(archived).toEqual({
      kind: ACCOUNT_LIST_OUTCOMES.OK,
      ids: [accountId(1004)],
    });

    const closed = await listIds(subjectOwner, workspaceWithAccountsId, {
      status: 'closed',
    });
    expect(closed).toEqual({
      kind: ACCOUNT_LIST_OUTCOMES.OK,
      ids: [accountId(1005)],
    });

    const active = await listIds(subjectOwner, workspaceWithAccountsId, {
      status: 'active',
    });
    if (active.kind !== ACCOUNT_LIST_OUTCOMES.OK)
      throw new Error('expected ok');
    expect(active.ids).toEqual([
      accountId(1006),
      accountId(1001),
      accountId(1002),
      accountId(1003),
    ]);
  });

  it('walks a status-filtered set with limit 1 across pages without repeating or dropping any', async () => {
    let cursor: Parameters<AccountsService['list']>[1]['cursor'] = undefined;
    const walked: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const outcome = await service.list(subjectOwner, {
        workspaceId: workspaceWithAccountsId,
        limit: 1,
        status: 'active',
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
        throw new Error(`expected ok, got ${outcome.kind}`);
      }
      walked.push(...outcome.page.items.map((item) => item.id));
      if (!outcome.page.pageInfo.hasNextPage) break;
      const nextCursor = outcome.page.pageInfo.nextCursor;
      if (nextCursor === null) {
        throw new Error('hasNextPage true but nextCursor null');
      }
      expect(decodeCursor(nextCursor)).toBeDefined();
      cursor = decodeCursor(nextCursor);
    }
    const expectedActiveOrder = [
      accountId(1006),
      accountId(1001),
      accountId(1002),
      accountId(1003),
    ];
    expect(walked).toEqual(expectedActiveOrder);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('maps snake_case columns onto the contract shape', async () => {
    const outcome = await service.list(subjectViewer, {
      workspaceId: workspaceWithAccountsId,
      limit: 50,
    });
    if (outcome.kind !== ACCOUNT_LIST_OUTCOMES.OK) {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    const creditCard = outcome.page.items.find(
      (item) => item.id === accountId(1005),
    );
    expect(creditCard).toEqual({
      id: accountId(1005),
      name: 'Credit card',
      type: 'credit_card',
      currency: 'USD',
      status: 'closed',
      institution: 'Acme Bank',
      maskedNumber: '**** 1234',
      description: 'Everyday card',
      colorToken: '#112233',
      icon: 'card',
      includeInNetWorth: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      version: 1,
    });
  });
});
