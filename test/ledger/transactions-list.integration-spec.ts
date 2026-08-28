import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRANSACTION_LIST_OUTCOMES,
  type TransactionStatus,
} from '../../src/ledger/ledger.port.js';
import { decodeCursor } from '../../src/platform/cursor.js';
import { TransactionService } from '../../src/ledger/transaction.service.js';
import { PostgresTransactionAdapter } from '../../src/ledger/postgres-transaction.adapter.js';
import { PostgresIdempotencyAdapter } from '../../src/platform/postgres-idempotency.adapter.js';
import { PgTransaction } from '../../src/platform/pg-transaction.js';
import { PostgresConfig } from '../../src/platform/postgres-config.js';
import { PostgresPool } from '../../src/platform/postgres-pool.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests.');

const subject = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const id = (number: number) =>
  `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

describe('TransactionService listTransactions database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresTransactionAdapter;
  let service: TransactionService;

  const subjectOwner = subject(900);
  const subjectViewer = subject(901);
  const subjectNonMember = subject(902);
  const subjectForeignOwner = subject(903);

  const workspace1Id = id(951);
  const foreignWorkspaceId = id(952);
  const absentWorkspaceId = id(999);

  const account1Id = id(6001);
  const account2Id = id(6002);
  const foreignAccountId = id(6003);

  const category1Id = id(5001);
  const category2Id = id(5002);

  // Microsecond seeds for workspace 1 with mixed timestamps and UUID tie-breaking
  // Ordered by (occurred_at DESC, id ASC):
  // 1. txn 7006: 2026-08-25T12:00:00.000000Z
  // 2. txn 7005: 2026-08-24T18:30:00.000500Z
  // 3. txn 7002: 2026-08-20T10:00:00.000200Z (tie on occurred_at with 7003, smaller UUID)
  // 4. txn 7003: 2026-08-20T10:00:00.000200Z (tie on occurred_at with 7002, larger UUID)
  // 5. txn 7001: 2026-08-20T10:00:00.000100Z
  // 6. txn 7004: 2026-08-15T08:00:00.000000Z
  const txn7001 = id(7001);
  const txn7002 = id(7002);
  const txn7003 = id(7003);
  const txn7004 = id(7004);
  const txn7005 = id(7005);
  const txn7006 = id(7006);
  const foreignTxnId = id(7099);

  const expectedDefaultOrder = [
    txn7006,
    txn7005,
    txn7002,
    txn7003,
    txn7001,
    txn7004,
  ];

  async function listIds(
    subjectId: string,
    workspaceId: string,
    options: {
      readonly limit?: number;
      readonly cursor?: Parameters<TransactionService['list']>[1]['cursor'];
      readonly accountId?: string;
      readonly from?: string;
      readonly to?: string;
      readonly categoryId?: string;
      readonly status?: TransactionStatus;
      readonly query?: string;
    } = {},
  ): Promise<
    | {
        readonly kind: typeof TRANSACTION_LIST_OUTCOMES.OK;
        readonly ids: readonly string[];
        readonly pageInfo: {
          readonly hasNextPage: boolean;
          readonly nextCursor: string | null;
        };
      }
    | { readonly kind: typeof TRANSACTION_LIST_OUTCOMES.FORBIDDEN }
  > {
    const outcome = await service.list(subjectId, {
      workspaceId,
      limit: options.limit ?? 50,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.accountId === undefined
        ? {}
        : { accountId: options.accountId }),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.categoryId === undefined
        ? {}
        : { categoryId: options.categoryId }),
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.query === undefined ? {} : { query: options.query }),
    });
    if (outcome.kind === TRANSACTION_LIST_OUTCOMES.FORBIDDEN) return outcome;
    return {
      kind: outcome.kind,
      ids: outcome.page.items.map((item) => item.id),
      pageInfo: outcome.page.pageInfo,
    };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    pool = new PostgresPool(PostgresConfig.fromUrl(url));
    transaction = new PgTransaction(pool, { callbackTimeoutMs: 3_000 });
    adapter = new PostgresTransactionAdapter();
    service = new TransactionService(
      transaction,
      adapter,
      new PostgresIdempotencyAdapter(),
    );

    // 1. Users
    await admin.query(
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
      [
        subjectOwner,
        'txn-list-owner@example.test',
        subjectViewer,
        'txn-list-viewer@example.test',
        subjectNonMember,
        'txn-list-nonmember@example.test',
        subjectForeignOwner,
        'txn-list-foreign@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectOwner, 'txn-list-owner@example.test', 'Txn List Owner'],
      [subjectViewer, 'txn-list-viewer@example.test', 'Txn List Viewer'],
      [
        subjectNonMember,
        'txn-list-nonmember@example.test',
        'Txn List Non Member',
      ],
      [
        subjectForeignOwner,
        'txn-list-foreign@example.test',
        'Txn List Foreign Owner',
      ],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 3. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Txn List Workspace One'],
      [foreignWorkspaceId, 'Txn List Foreign Workspace'],
    ] as const) {
      await admin.query(
        `insert into public.workspaces (id, name, kind, base_currency, personal_owner_profile_id)
         values ($1, $2, 'shared', 'USD', null)`,
        [wsId, name],
      );
    }

    // 4. Memberships
    await admin.query(
      `insert into public.workspace_memberships (workspace_id, profile_id, role, status)
       values ($1, $2, 'owner', 'active'),
              ($1, $3, 'viewer', 'active'),
              ($4, $5, 'owner', 'active')`,
      [
        workspace1Id,
        subjectOwner,
        subjectViewer,
        foreignWorkspaceId,
        subjectForeignOwner,
      ],
    );

    // 5. Accounts
    for (const [accId, wsId, name] of [
      [account1Id, workspace1Id, 'Checking Account'],
      [account2Id, workspace1Id, 'Savings Account'],
      [foreignAccountId, foreignWorkspaceId, 'Foreign Account'],
    ] as const) {
      await admin.query(
        `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
         values ($1, $2, $3, 'checking', 'USD', 'active', $4)`,
        [accId, wsId, name, subjectOwner],
      );
    }

    // 6. Transactions in workspace 1
    const seeds = [
      {
        id: txn7001,
        accountId: account1Id,
        type: 'expense',
        status: 'confirmed',
        amountMinor: '1000',
        occurredAt: '2026-08-20T10:00:00.000100+00',
        description: 'Coffee at Starbucks',
        notes: 'Morning routine',
        categoryId: category1Id,
      },
      {
        id: txn7002,
        accountId: account1Id,
        type: 'expense',
        status: 'confirmed',
        amountMinor: '2500',
        occurredAt: '2026-08-20T10:00:00.000200+00',
        description: 'Lunch with team',
        notes: 'Project kickoff discussion',
        categoryId: category1Id,
      },
      {
        id: txn7003,
        accountId: account2Id,
        type: 'income',
        status: 'pending',
        amountMinor: '50000',
        occurredAt: '2026-08-20T10:00:00.000200+00',
        description: 'Consulting payment',
        notes: 'Invoice 1024',
        categoryId: category2Id,
      },
      {
        id: txn7004,
        accountId: account1Id,
        type: 'expense',
        status: 'draft',
        amountMinor: '8000',
        occurredAt: '2026-08-15T08:00:00.000000+00',
        description: 'Office Supplies',
        notes: 'Notebooks and pens',
        categoryId: category2Id,
      },
      {
        id: txn7005,
        accountId: account2Id,
        type: 'income',
        status: 'reconciled',
        amountMinor: '120000',
        occurredAt: '2026-08-24T18:30:00.000500+00',
        description: 'Client retainer',
        notes: 'August retainer fee',
        categoryId: category1Id,
      },
      {
        id: txn7006,
        accountId: account1Id,
        type: 'adjustment',
        status: 'voided',
        amountMinor: '300',
        occurredAt: '2026-08-25T12:00:00.000000+00',
        description: 'Bank fee adjustment',
        notes: 'Reversed erroneous charge',
        categoryId: null,
        voidedAt: '2026-08-25T12:05:00.000000+00',
      },
    ];

    for (const s of seeds) {
      await admin.query(
        `insert into public.transactions
           (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
            description, notes, category_id, created_by, voided_at)
         values ($1, $2, $3, $4, $5, $6, 'USD', $7::timestamptz, $8, $9, $10, $11, $12::timestamptz)`,
        [
          s.id,
          workspace1Id,
          s.accountId,
          s.type,
          s.status,
          s.amountMinor,
          s.occurredAt,
          s.description,
          s.notes,
          s.categoryId,
          subjectOwner,
          'voidedAt' in s ? s.voidedAt : null,
        ],
      );
    }

    // 7. Seed transaction in foreign workspace for isolation vacuity guard
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
          description, notes, created_by)
       values ($1, $2, $3, 'income', 'confirmed', 99999, 'USD', now(), 'Secret foreign transaction', 'Do not leak', $4)`,
      [foreignTxnId, foreignWorkspaceId, foreignAccountId, subjectForeignOwner],
    );
  });

  afterAll(async () => {
    await admin.end();
    await transaction.close();
  });

  it('200 happy path scoped to X-Workspace-Id with pageInfo in occurred_at desc, id asc order', async () => {
    const outcome = await listIds(subjectOwner, workspace1Id);
    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (outcome.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;

    expect(outcome.ids).toEqual(expectedDefaultOrder);
    expect(outcome.pageInfo).toEqual({
      hasNextPage: false,
      nextCursor: null,
    });
  });

  it('keyset pagination proof: inserting a row between page fetches causes no duplicates and no missing items across pages', async () => {
    // 1. Fetch page 1 with limit 2
    const page1Outcome = await listIds(subjectOwner, workspace1Id, {
      limit: 2,
    });
    expect(page1Outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (page1Outcome.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;

    expect(page1Outcome.ids).toEqual([txn7006, txn7005]);
    expect(page1Outcome.pageInfo.hasNextPage).toBe(true);
    expect(page1Outcome.pageInfo.nextCursor).not.toBeNull();

    const cursor1 = decodeCursor(page1Outcome.pageInfo.nextCursor!);
    expect(cursor1).toBeDefined();

    // 2. Insert a new row BETWEEN page fetches that falls into page 1's occurred_at window
    // (e.g. occurred_at newer than txn7005)
    const insertedTxnId = id(7088);
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
          description, notes, created_by)
       values ($1, $2, $3, 'expense', 'confirmed', 500, 'USD', '2026-08-25T18:00:00.000000+00'::timestamptz,
               'Interleaved txn', 'Between pages test', $4)`,
      [insertedTxnId, workspace1Id, account1Id, subjectOwner],
    );

    try {
      // 3. Fetch remaining pages using keyset cursor
      const remainingIds: string[] = [];
      let currentCursor = cursor1;

      while (currentCursor !== undefined) {
        const nextPage = await listIds(subjectOwner, workspace1Id, {
          limit: 2,
          cursor: currentCursor,
        });
        if (nextPage.kind !== TRANSACTION_LIST_OUTCOMES.OK) {
          throw new Error('Expected next page to return OK');
        }
        remainingIds.push(...nextPage.ids);
        if (
          !nextPage.pageInfo.hasNextPage ||
          nextPage.pageInfo.nextCursor === null
        ) {
          break;
        }
        currentCursor = decodeCursor(nextPage.pageInfo.nextCursor);
      }

      // 4. Under keyset pagination, page 1 + remaining pages contains every original item
      // exactly once (no duplicates, no misses). Under offset pagination, the insert shifts
      // offset and duplicates txn7005 or misses an item.
      const allWalkedIds = [...page1Outcome.ids, ...remainingIds];
      expect(allWalkedIds).toEqual(expectedDefaultOrder);
      expect(new Set(allWalkedIds).size).toBe(expectedDefaultOrder.length);
    } finally {
      // Clean up the interleaved transaction
      await admin.query('delete from public.transactions where id = $1::uuid', [
        insertedTxnId,
      ]);
    }
  });

  it('isolation vacuity guard: caller with no active role in foreign workspace gets 403 (target workspace genuinely contains rows)', async () => {
    // Verify foreign workspace actually contains transaction rows
    const countRes = await admin.query<{ count: string }>(
      'select count(*) as count from public.transactions where workspace_id = $1::uuid',
      [foreignWorkspaceId],
    );
    expect(Number(countRes.rows[0]?.count)).toBeGreaterThan(0);

    // subjectOwner has no membership in foreignWorkspaceId -> MUST get 403 FORBIDDEN, not 200 []
    const outcome = await listIds(subjectOwner, foreignWorkspaceId);
    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.FORBIDDEN);
  });

  it('refuses an absent workspace with 403 to prevent leaking existence', async () => {
    const outcome = await listIds(subjectOwner, absentWorkspaceId);
    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.FORBIDDEN);
  });

  it('lets a viewer list transactions because select policy admits all four roles', async () => {
    const outcome = await listIds(subjectViewer, workspace1Id);
    expect(outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (outcome.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(outcome.ids).toEqual(expectedDefaultOrder);
  });

  it('filters by accountId', async () => {
    const acc2Outcome = await listIds(subjectOwner, workspace1Id, {
      accountId: account2Id,
    });
    expect(acc2Outcome.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (acc2Outcome.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(acc2Outcome.ids).toEqual([txn7005, txn7003]);
  });

  it('filters by status', async () => {
    const confirmed = await listIds(subjectOwner, workspace1Id, {
      status: 'confirmed',
    });
    expect(confirmed.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (confirmed.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(confirmed.ids).toEqual([txn7002, txn7001]);

    const voided = await listIds(subjectOwner, workspace1Id, {
      status: 'voided',
    });
    expect(voided.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (voided.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(voided.ids).toEqual([txn7006]);
  });

  it('filters by categoryId', async () => {
    const cat1 = await listIds(subjectOwner, workspace1Id, {
      categoryId: category1Id,
    });
    expect(cat1.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (cat1.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(cat1.ids).toEqual([txn7005, txn7002, txn7001]);
  });

  it('filters by from and to date range', async () => {
    // Range 2026-08-20 to 2026-08-24 (inclusive)
    const range = await listIds(subjectOwner, workspace1Id, {
      from: '2026-08-20',
      to: '2026-08-24',
    });
    expect(range.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (range.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(range.ids).toEqual([txn7005, txn7002, txn7003, txn7001]);
  });

  it('filters by query across description and notes case-insensitively', async () => {
    // Match in description: 'coffee' matches 'Coffee at Starbucks'
    const descMatch = await listIds(subjectOwner, workspace1Id, {
      query: 'coffee',
    });
    expect(descMatch.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (descMatch.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(descMatch.ids).toEqual([txn7001]);

    // Match in notes: 'kickoff' matches 'Project kickoff discussion'
    const notesMatch = await listIds(subjectOwner, workspace1Id, {
      query: 'kickoff',
    });
    expect(notesMatch.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (notesMatch.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(notesMatch.ids).toEqual([txn7002]);
  });

  it('combines filters as an intersection (AND), not union (OR)', async () => {
    // category1Id has [txn7005, txn7002, txn7001]; account2Id has [txn7005, txn7003]
    // Intersection is [txn7005]
    const combined = await listIds(subjectOwner, workspace1Id, {
      categoryId: category1Id,
      accountId: account2Id,
    });
    expect(combined.kind).toBe(TRANSACTION_LIST_OUTCOMES.OK);
    if (combined.kind !== TRANSACTION_LIST_OUTCOMES.OK) return;
    expect(combined.ids).toEqual([txn7005]);
  });
});
