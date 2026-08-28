import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TRANSACTION_READ_OUTCOMES } from '../../src/ledger/ledger.port.js';
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

describe('TransactionService getTransaction database boundary', () => {
  let admin: Pool;
  let pool: PostgresPool;
  let transaction: PgTransaction;
  let adapter: PostgresTransactionAdapter;
  let service: TransactionService;

  const subjectDualMember = subject(900); // Member of workspace 1 and workspace 2
  const subjectViewer = subject(901); // Viewer in workspace 1
  const subjectNonMember = subject(902); // Non-member of workspace 1

  const workspace1Id = id(951);
  const workspace2Id = id(952);
  const absentWorkspaceId = id(999);

  const accountW1Id = id(6001);
  const accountW2Id = id(6002);

  const txnW1AId = id(7001);
  const txnW1BId = id(7002);
  const txnW2Id = id(7003);
  const absentTxnId = id(7999);

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
      `insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)`,
      [
        subjectDualMember,
        'txn-get-dual@example.test',
        subjectViewer,
        'txn-get-viewer@example.test',
        subjectNonMember,
        'txn-get-nonmember@example.test',
      ],
    );

    // 2. Profiles
    for (const [userId, email, name] of [
      [subjectDualMember, 'txn-get-dual@example.test', 'Txn Dual Member'],
      [subjectViewer, 'txn-get-viewer@example.test', 'Txn Viewer'],
      [subjectNonMember, 'txn-get-nonmember@example.test', 'Txn Non Member'],
    ] as const) {
      await admin.query(
        `insert into public.profiles (id, email, display_name, locale, country_code, timezone, date_format, week_starts_on, number_format, default_currency, privacy_mode_enabled)
         values ($1, $2, $3, 'en', 'US', 'UTC', 'YYYY-MM-DD', 1, '1,234.56', 'USD', false)`,
        [userId, email, name],
      );
    }

    // 3. Workspaces
    for (const [wsId, name] of [
      [workspace1Id, 'Txn Get Workspace One'],
      [workspace2Id, 'Txn Get Workspace Two'],
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
              ($3, $2, 'owner', 'active'),
              ($1, $4, 'viewer', 'active')`,
      [workspace1Id, subjectDualMember, workspace2Id, subjectViewer],
    );

    // 5. Accounts
    await admin.query(
      `insert into public.accounts (id, workspace_id, name, type, currency, status, created_by)
       values ($1, $2, 'Primary Checking', 'checking', 'USD', 'active', $3),
              ($4, $5, 'Workspace 2 Savings', 'savings', 'USD', 'active', $3)`,
      [accountW1Id, workspace1Id, subjectDualMember, accountW2Id, workspace2Id],
    );

    // 6. Transactions
    // Workspace 1, Transaction A (full fields)
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
          description, notes, category_id, payee_id, receipt_id, tag_ids, created_by, created_at, updated_at, version)
       values ($1, $2, $3, 'expense', 'confirmed', 5000, 'USD', '2026-08-20T10:00:00.000Z'::timestamptz,
               'Office Supplies', 'Pens and notebooks', $4, $5, $6, $7::uuid[], $8,
               '2026-08-20T10:00:00.000Z'::timestamptz, '2026-08-20T10:00:00.000Z'::timestamptz, 1)`,
      [
        txnW1AId,
        workspace1Id,
        accountW1Id,
        id(8001),
        id(8002),
        id(8003),
        [id(8004)],
        subjectDualMember,
      ],
    );
    await admin.query(
      `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
       values ($1, $2, $3, 'account', 5000, 'USD', 'confirmed', '2026-08-20T10:00:00.000Z'::timestamptz),
              ($1, $2, null, 'external', -5000, 'USD', 'confirmed', '2026-08-20T10:00:00.000Z'::timestamptz)`,
      [workspace1Id, txnW1AId, accountW1Id],
    );

    // Workspace 1, Transaction B (nullable fields null)
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
          description, notes, category_id, payee_id, receipt_id, tag_ids, created_by, created_at, updated_at, version)
       values ($1, $2, $3, 'income', 'pending', 12000, 'USD', '2026-08-21T12:00:00.000Z'::timestamptz,
               null, null, null, null, null, null, $4,
               '2026-08-21T12:00:00.000Z'::timestamptz, '2026-08-21T12:00:00.000Z'::timestamptz, 2)`,
      [txnW1BId, workspace1Id, accountW1Id, subjectDualMember],
    );
    await admin.query(
      `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
       values ($1, $2, $3, 'account', 12000, 'USD', 'pending', '2026-08-21T12:00:00.000Z'::timestamptz),
              ($1, $2, null, 'external', -12000, 'USD', 'pending', '2026-08-21T12:00:00.000Z'::timestamptz)`,
      [workspace1Id, txnW1BId, accountW1Id],
    );

    // Workspace 2 Transaction
    await admin.query(
      `insert into public.transactions
         (id, workspace_id, account_id, type, status, amount_minor, currency, occurred_at,
          description, notes, category_id, payee_id, receipt_id, tag_ids, created_by, created_at, updated_at, version)
       values ($1, $2, $3, 'expense', 'confirmed', 3000, 'USD', '2026-08-22T14:00:00.000Z'::timestamptz,
               'Workspace 2 Expense', null, null, null, null, null, $4,
               '2026-08-22T14:00:00.000Z'::timestamptz, '2026-08-22T14:00:00.000Z'::timestamptz, 1)`,
      [txnW2Id, workspace2Id, accountW2Id, subjectDualMember],
    );
    await admin.query(
      `insert into public.ledger_postings (workspace_id, transaction_id, account_id, leg_kind, amount_minor, currency, status, occurred_at)
       values ($1, $2, $3, 'account', 3000, 'USD', 'confirmed', '2026-08-22T14:00:00.000Z'::timestamptz),
              ($1, $2, null, 'external', -3000, 'USD', 'confirmed', '2026-08-22T14:00:00.000Z'::timestamptz)`,
      [workspace2Id, txnW2Id, accountW2Id],
    );
  });

  afterAll(async () => {
    await admin.query(`delete from public.workspaces where id in ($1, $2)`, [
      workspace1Id,
      workspace2Id,
    ]);
    await admin.query(`delete from auth.users where id in ($1, $2, $3)`, [
      subjectDualMember,
      subjectViewer,
      subjectNonMember,
    ]);
    await pool.end();
    await admin.end();
  });

  it('refuses access with forbidden (403) when the caller has no active role in the workspace', async () => {
    const outcome = await service.read(
      subjectNonMember,
      workspace1Id,
      txnW1AId,
    );
    expect(outcome.kind).toBe(TRANSACTION_READ_OUTCOMES.FORBIDDEN);
  });

  it('refuses access with forbidden (403) when the workspace does not exist', async () => {
    const outcome = await service.read(
      subjectDualMember,
      absentWorkspaceId,
      txnW1AId,
    );
    expect(outcome.kind).toBe(TRANSACTION_READ_OUTCOMES.FORBIDDEN);
  });

  it('returns not_found (404) when the caller is authorized but the transaction does not exist in the workspace', async () => {
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      absentTxnId,
    );
    expect(outcome.kind).toBe(TRANSACTION_READ_OUTCOMES.NOT_FOUND);
  });

  it('returns not_found (404, never 403) when the transaction exists but belongs to a different workspace', async () => {
    // Viewer is only member of workspace 1, looking for workspace 2's transaction in workspace 1
    const outcome = await service.read(subjectViewer, workspace1Id, txnW2Id);
    expect(outcome.kind).toBe(TRANSACTION_READ_OUTCOMES.NOT_FOUND);
  });

  it('proves scoping is by requested workspace and not actor visibility: dual member requesting workspace 1 cannot read workspace 2 transaction (returns 404)', async () => {
    // subjectDualMember is an active owner in BOTH workspace 1 and workspace 2.
    // When querying with workspace1Id, txnW2Id MUST return not_found (404),
    // proving the transaction lookup is scoped strictly by workspace_id in the SQL predicate.
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      txnW2Id,
    );
    expect(outcome.kind).toBe(TRANSACTION_READ_OUTCOMES.NOT_FOUND);
  });

  it('adapter-level cross-tenant proof: calling readTransaction directly with mismatched workspaceId returns undefined', async () => {
    await transaction.runRead(subjectDualMember, async (client) => {
      // Calling store method directly with workspace 2 ID and workspace 1's transaction ID
      const directMismatch = await adapter.readTransaction(
        client,
        workspace2Id,
        txnW1AId,
      );
      expect(directMismatch).toBeUndefined();

      // Calling store method directly with workspace 1 ID and workspace 2's transaction ID
      const directMismatchReverse = await adapter.readTransaction(
        client,
        workspace1Id,
        txnW2Id,
      );
      expect(directMismatchReverse).toBeUndefined();

      // Calling with correct workspace ID returns the transaction
      const directMatch = await adapter.readTransaction(
        client,
        workspace1Id,
        txnW1AId,
      );
      expect(directMatch).toBeDefined();
      expect(directMatch?.id).toBe(txnW1AId);
    });
  });

  it('reads transaction successfully returning full domain model and version', async () => {
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      txnW1AId,
    );
    expect(outcome).toEqual({
      kind: TRANSACTION_READ_OUTCOMES.OK,
      transaction: {
        id: txnW1AId,
        accountId: accountW1Id,
        type: 'expense',
        status: 'confirmed',
        amount: {
          amountMinor: '5000',
          currency: 'USD',
        },
        occurredAt: '2026-08-20T10:00:00.000Z',
        description: 'Office Supplies',
        notes: 'Pens and notebooks',
        categoryId: id(8001),
        payeeId: id(8002),
        receiptId: id(8003),
        reconciliationId: null,
        tagIds: [id(8004)],
        createdAt: '2026-08-20T10:00:00.000Z',
        updatedAt: '2026-08-20T10:00:00.000Z',
        version: 1,
      },
    });
  });

  it('admits a viewer because the select policy admits all four roles', async () => {
    const outcome = await service.read(subjectViewer, workspace1Id, txnW1AId);
    expect(outcome.kind).toBe(TRANSACTION_READ_OUTCOMES.OK);
    if (outcome.kind === TRANSACTION_READ_OUTCOMES.OK) {
      expect(outcome.transaction.id).toBe(txnW1AId);
      expect(outcome.transaction.version).toBe(1);
    }
  });

  it('maps nullable fields correctly when null in database', async () => {
    const outcome = await service.read(
      subjectDualMember,
      workspace1Id,
      txnW1BId,
    );
    expect(outcome).toEqual({
      kind: TRANSACTION_READ_OUTCOMES.OK,
      transaction: {
        id: txnW1BId,
        accountId: accountW1Id,
        type: 'income',
        status: 'pending',
        amount: {
          amountMinor: '12000',
          currency: 'USD',
        },
        occurredAt: '2026-08-21T12:00:00.000Z',
        description: null,
        notes: null,
        categoryId: null,
        payeeId: null,
        receiptId: null,
        reconciliationId: null,
        tagIds: [],
        createdAt: '2026-08-21T12:00:00.000Z',
        updatedAt: '2026-08-21T12:00:00.000Z',
        version: 2,
      },
    });
  });
});
