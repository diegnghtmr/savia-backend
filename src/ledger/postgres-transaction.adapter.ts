import type { TransactionClient } from '../platform/pg-transaction.js';
import { enforceDeferredConstraints } from '../platform/deferred-constraints.js';
import type {
  CreateTransactionCommand,
  Transaction,
  TransactionCursor,
  UpdateTransactionCommand,
} from './ledger.port.js';
import {
  TransactionCategoryNotFoundError,
  TransactionPayeeNotFoundError,
  type LedgerAccountRecord,
  type LedgerStore,
  type TransactionFilterOptions,
  type TransactionItem,
} from './transaction.service.js';

interface TransactionRow extends Record<string, unknown> {
  readonly id: string;
  readonly accountId: string;
  readonly type: Transaction['type'];
  readonly status: Transaction['status'];
  readonly amountMinor: string;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly description: string | null;
  readonly notes: string | null;
  readonly categoryId: string | null;
  readonly payeeId: string | null;
  readonly receiptId: string | null;
  readonly reconciliationId: string | null;
  readonly tagIds: string[] | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

interface TransactionListRow extends TransactionRow {
  readonly cursorAt: string;
}

const INT8_MAX = 9223372036854775807n;

export function negateAmountMinor(amountMinor: string): string {
  if (amountMinor === '0' || amountMinor === '-0') {
    return '0';
  }
  if (BigInt(amountMinor) < -INT8_MAX) {
    throw new RangeError(
      `amountMinor ${amountMinor} cannot be negated within int8; its counter-leg would overflow`,
    );
  }
  if (amountMinor.startsWith('-')) {
    return amountMinor.slice(1);
  }
  return `-${amountMinor}`;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new TypeError(
    `Expected Date instance from database timestamp column, got ${typeof value}`,
  );
}

export class PostgresTransactionAdapter implements LedgerStore {
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    const role = result.rows[0]?.role;
    return typeof role === 'string' ? role : undefined;
  }

  public async lockAndReadAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<LedgerAccountRecord | undefined> {
    // 1. Mandatory per-account advisory lock (serialized against closeAccount)
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountId.toLowerCase()],
    );

    // 2. Pre-check account existence and status in workspace
    const accountResult = await client.query<{ status: string }>(
      'select a.status from public.accounts a where a.workspace_id = $1::uuid and a.id = $2::uuid',
      [workspaceId, accountId],
    );
    const accountRow = accountResult.rows[0];
    if (!accountRow) {
      return undefined;
    }
    return { status: accountRow.status };
  }

  public async createTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: CreateTransactionCommand,
  ): Promise<Transaction> {
    // 1. Insert transaction header row
    const txnSql = `
insert into public.transactions (
  workspace_id,
  account_id,
  type,
  status,
  amount_minor,
  currency,
  occurred_at,
  description,
  notes,
  category_id,
  payee_id,
  receipt_id,
  tag_ids,
  created_by
)
values (
  $1::uuid,
  $2::uuid,
  $3,
  $4,
  $5,
  $6,
  $7::timestamptz,
  $8,
  $9,
  $10::uuid,
  $11::uuid,
  $12::uuid,
  $13::uuid[],
  $14::uuid
)
returning
  id::text,
  account_id::text as "accountId",
  type,
  status,
  amount_minor as "amountMinor",
  currency,
  occurred_at as "occurredAt",
  description,
  notes,
  category_id::text as "categoryId",
  payee_id::text as "payeeId",
  receipt_id::text as "receiptId",
  reconciliation_id::text as "reconciliationId",
  tag_ids as "tagIds",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;

    const txnValues = [
      workspaceId,
      command.accountId,
      command.type,
      command.status,
      command.amount.amountMinor,
      command.amount.currency,
      command.occurredAt,
      command.description ?? null,
      command.notes ?? null,
      command.categoryId ?? null,
      command.payeeId ?? null,
      command.receiptId ?? null,
      command.tagIds && command.tagIds.length > 0 ? command.tagIds : null,
      subject,
    ];

    let txnResult: { rows: TransactionRow[] };
    try {
      txnResult = await client.query<TransactionRow>(txnSql, txnValues);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const pgError = error as { code: string; constraint?: string };
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'transactions_category_workspace_fkey'
        ) {
          throw new TransactionCategoryNotFoundError();
        }
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'transactions_payee_workspace_fkey'
        ) {
          throw new TransactionPayeeNotFoundError();
        }
      }
      throw error;
    }
    const row = txnResult.rows[0];
    if (!row) {
      throw new Error('Created transaction row could not be read.');
    }

    // 2. Insert balanced pair of ledger postings
    const postingsSql = `
insert into public.ledger_postings (
  workspace_id,
  transaction_id,
  account_id,
  leg_kind,
  amount_minor,
  currency,
  status,
  occurred_at
)
values
  ($1::uuid, $2::uuid, $3::uuid, 'account', $4, $5, $6, $7),
  ($1::uuid, $2::uuid, null, 'external', $8, $5, $6, $7)`;

    const postingsValues = [
      workspaceId,
      row.id,
      command.accountId,
      command.amount.amountMinor,
      command.amount.currency,
      command.status,
      row.occurredAt,
      negateAmountMinor(command.amount.amountMinor),
    ];

    await client.query(postingsSql, postingsValues);

    // 3. Enforce deferred constraints (e.g. balanced-postings check) before commit
    await enforceDeferredConstraints(client);

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      accountId: row.accountId,
      amount: {
        amountMinor: String(row.amountMinor),
        currency: row.currency,
      },
      occurredAt: toIso(row.occurredAt),
      categoryId: row.categoryId,
      payeeId: row.payeeId,
      description: row.description,
      notes: row.notes,
      tagIds: Array.isArray(row.tagIds) ? row.tagIds : [],
      receiptId: row.receiptId,
      reconciliationId: row.reconciliationId,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      version: row.version,
    };
  }

  public async readTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
  ): Promise<Transaction | undefined> {
    const sql = `
select t.id::text,
       t.account_id::text as "accountId",
       t.type,
       t.status,
       t.amount_minor as "amountMinor",
       t.currency,
       t.occurred_at as "occurredAt",
       t.description,
       t.notes,
       t.category_id::text as "categoryId",
       t.payee_id::text as "payeeId",
       t.receipt_id::text as "receiptId",
       t.reconciliation_id::text as "reconciliationId",
       t.tag_ids as "tagIds",
       t.created_at as "createdAt",
       t.updated_at as "updatedAt",
       t.version
  from public.transactions t
 where t.workspace_id = $1::uuid
   and t.id = $2::uuid`;
    const result = await client.query<TransactionRow>(sql, [
      workspaceId,
      transactionId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      accountId: row.accountId,
      type: row.type,
      status: row.status,
      amount: {
        amountMinor: String(row.amountMinor),
        currency: row.currency,
      },
      occurredAt: toIso(row.occurredAt),
      categoryId: row.categoryId,
      payeeId: row.payeeId,
      description: row.description,
      notes: row.notes,
      tagIds: Array.isArray(row.tagIds) ? row.tagIds : [],
      receiptId: row.receiptId,
      reconciliationId: row.reconciliationId,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      version: row.version,
    };
  }

  public async listTransactions(
    client: TransactionClient,
    workspaceId: string,
    cursor: TransactionCursor | undefined,
    limit: number,
    filters: TransactionFilterOptions,
  ): Promise<readonly TransactionItem[]> {
    const conditions = ['t.workspace_id = $1::uuid'];
    const values: unknown[] = [workspaceId];

    if (cursor !== undefined) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(t.occurred_at < $${values.length - 1}::timestamptz or (t.occurred_at = $${values.length - 1}::timestamptz and t.id > $${values.length}::uuid))`,
      );
    }

    if (filters.accountId !== undefined) {
      values.push(filters.accountId);
      conditions.push(`t.account_id = $${values.length}::uuid`);
    }

    if (filters.status !== undefined) {
      values.push(filters.status);
      conditions.push(`t.status = $${values.length}`);
    }

    if (filters.categoryId !== undefined) {
      values.push(filters.categoryId);
      conditions.push(`t.category_id = $${values.length}::uuid`);
    }

    if (filters.from !== undefined) {
      values.push(filters.from);
      conditions.push(`t.occurred_at >= $${values.length}::timestamptz`);
    }

    if (filters.to !== undefined) {
      values.push(filters.to);
      conditions.push(
        `t.occurred_at < ($${values.length}::timestamptz + interval '1 day')`,
      );
    }

    if (filters.query !== undefined) {
      values.push(filters.query);
      conditions.push(
        `(t.description ilike ('%' || $${values.length} || '%') or t.notes ilike ('%' || $${values.length} || '%'))`,
      );
    }

    values.push(limit);
    const sql = `
select t.id::text,
       t.account_id::text as "accountId",
       t.type,
       t.status,
       t.amount_minor as "amountMinor",
       t.currency,
       t.occurred_at as "occurredAt",
       t.description,
       t.notes,
       t.category_id::text as "categoryId",
       t.payee_id::text as "payeeId",
       t.receipt_id::text as "receiptId",
       t.reconciliation_id::text as "reconciliationId",
       t.tag_ids as "tagIds",
       t.created_at as "createdAt",
       t.updated_at as "updatedAt",
       t.version,
       to_char(t.occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
  from public.transactions t
 where ${conditions.join('\n   and ')}
 order by t.occurred_at desc, t.id asc
 limit $${values.length}`;

    const result = await client.query<TransactionListRow>(sql, values);
    return result.rows.map((row) => ({
      transaction: {
        id: row.id,
        accountId: row.accountId,
        type: row.type,
        status: row.status,
        amount: {
          amountMinor: String(row.amountMinor),
          currency: row.currency,
        },
        occurredAt: toIso(row.occurredAt),
        categoryId: row.categoryId,
        payeeId: row.payeeId,
        description: row.description,
        notes: row.notes,
        tagIds: Array.isArray(row.tagIds) ? row.tagIds : [],
        receiptId: row.receiptId,
        reconciliationId: row.reconciliationId,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        version: row.version,
      },
      cursorAt: row.cursorAt,
    }));
  }

  public async updateTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
    command: UpdateTransactionCommand,
    expectedVersions?: number | readonly number[],
  ): Promise<Transaction | undefined> {
    const assignments: string[] = [
      'updated_at = now()',
      'version = version + 1',
    ];
    const values: unknown[] = [workspaceId, transactionId];

    if ('occurredAt' in command && command.occurredAt !== undefined) {
      values.push(command.occurredAt);
      assignments.push(`occurred_at = $${values.length}::timestamptz`);
    }

    if ('categoryId' in command) {
      values.push(command.categoryId);
      assignments.push(`category_id = $${values.length}::uuid`);
    }

    if ('payeeId' in command) {
      values.push(command.payeeId);
      assignments.push(`payee_id = $${values.length}::uuid`);
    }

    if ('description' in command) {
      values.push(command.description);
      assignments.push(`description = $${values.length}`);
    }

    if ('notes' in command) {
      values.push(command.notes);
      assignments.push(`notes = $${values.length}`);
    }

    if ('tagIds' in command) {
      values.push(
        command.tagIds && command.tagIds.length > 0 ? command.tagIds : null,
      );
      assignments.push(`tag_ids = $${values.length}::uuid[]`);
    }

    if ('status' in command && command.status !== undefined) {
      values.push(command.status);
      assignments.push(`status = $${values.length}`);
    }

    const versionParam =
      expectedVersions === undefined
        ? null
        : typeof expectedVersions === 'number'
          ? [expectedVersions]
          : [...expectedVersions];
    values.push(versionParam);
    const versionParamIndex = values.length;

    const sql = `
update public.transactions
   set ${assignments.join(', ')}
 where workspace_id = $1::uuid
   and id = $2::uuid
   and ($${versionParamIndex}::integer[] is null or version = any($${versionParamIndex}::integer[]))
returning
   id::text,
   account_id::text as "accountId",
   type,
   status,
   amount_minor as "amountMinor",
   currency,
   occurred_at as "occurredAt",
   description,
   notes,
   category_id::text as "categoryId",
   payee_id::text as "payeeId",
   receipt_id::text as "receiptId",
   reconciliation_id::text as "reconciliationId",
   tag_ids as "tagIds",
   created_at as "createdAt",
   updated_at as "updatedAt",
   version`;

    let result: { rows: TransactionRow[] };
    try {
      result = await client.query<TransactionRow>(sql, values);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const pgError = error as { code: string; constraint?: string };
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'transactions_category_workspace_fkey'
        ) {
          throw new TransactionCategoryNotFoundError();
        }
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'transactions_payee_workspace_fkey'
        ) {
          throw new TransactionPayeeNotFoundError();
        }
      }
      throw error;
    }
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      accountId: row.accountId,
      type: row.type,
      status: row.status,
      amount: {
        amountMinor: String(row.amountMinor),
        currency: row.currency,
      },
      occurredAt: toIso(row.occurredAt),
      categoryId: row.categoryId,
      payeeId: row.payeeId,
      description: row.description,
      notes: row.notes,
      tagIds: Array.isArray(row.tagIds) ? row.tagIds : [],
      receiptId: row.receiptId,
      reconciliationId: row.reconciliationId,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      version: row.version,
    };
  }

  public async voidTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
    accountId: string,
    postingStatus: string,
    expectedVersions?: number | readonly number[],
  ): Promise<Transaction | undefined> {
    // 1. Mandatory per-account advisory lock (serialized against closeAccount and createTransaction)
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountId.toLowerCase()],
    );

    // 2. Status flip setting status='voided', voided_at=now(), updated_at=now(), version=version+1
    const versionParam =
      expectedVersions === undefined
        ? null
        : typeof expectedVersions === 'number'
          ? [expectedVersions]
          : [...expectedVersions];

    const sql = `
update public.transactions
   set status = 'voided',
       voided_at = now(),
       updated_at = now(),
       version = version + 1
 where workspace_id = $1::uuid
   and id = $2::uuid
   and status in ('pending', 'confirmed')
   and ($3::integer[] is null or version = any($3::integer[]))
returning
   id::text,
   account_id::text as "accountId",
   type,
   status,
   amount_minor as "amountMinor",
   currency,
   occurred_at as "occurredAt",
   description,
   notes,
   category_id::text as "categoryId",
   payee_id::text as "payeeId",
   receipt_id::text as "receiptId",
   reconciliation_id::text as "reconciliationId",
   tag_ids as "tagIds",
   voided_at as "voidedAt",
   created_at as "createdAt",
   updated_at as "updatedAt",
   version`;

    const result = await client.query<TransactionRow & { voidedAt: Date }>(
      sql,
      [workspaceId, transactionId, versionParam],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    // 3. Append compensating posting set (negated amounts, same currency, void instant occurred_at)
    const postingsSql = `
insert into public.ledger_postings (
  workspace_id,
  transaction_id,
  account_id,
  leg_kind,
  amount_minor,
  currency,
  status,
  occurred_at
)
values
  ($1::uuid, $2::uuid, $3::uuid, 'account', $4, $5, $6, $7),
  ($1::uuid, $2::uuid, null, 'external', $8, $5, $6, $7)`;

    const postingsValues = [
      workspaceId,
      row.id,
      row.accountId,
      negateAmountMinor(String(row.amountMinor)),
      row.currency,
      postingStatus,
      row.voidedAt,
      String(row.amountMinor),
    ];

    await client.query(postingsSql, postingsValues);

    // 4. Enforce deferred constraints (balanced postings check) before commit
    await enforceDeferredConstraints(client);

    return {
      id: row.id,
      accountId: row.accountId,
      type: row.type,
      status: row.status,
      amount: {
        amountMinor: String(row.amountMinor),
        currency: row.currency,
      },
      occurredAt: toIso(row.occurredAt),
      categoryId: row.categoryId,
      payeeId: row.payeeId,
      description: row.description,
      notes: row.notes,
      tagIds: Array.isArray(row.tagIds) ? row.tagIds : [],
      receiptId: row.receiptId,
      reconciliationId: row.reconciliationId,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      version: row.version,
    };
  }
}
