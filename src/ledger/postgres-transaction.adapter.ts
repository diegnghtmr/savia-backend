import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  AdjustmentTransactionCommand,
  ImportedTransactionCommand,
  LedgerWriter,
} from '../platform/ledger-writer.port.js';
import { enforceDeferredConstraints } from '../platform/deferred-constraints.js';
import { negateAmountMinor } from '../platform/amount-minor.js';
import type {
  CreateTransactionCommand,
  Transaction,
  TransactionCursor,
  UpdateTransactionCommand,
} from './ledger.port.js';
import { IMPORT_COMMIT_BATCH_SIZE } from '../platform/import-batch-policy.js';
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
  readonly archived?: boolean;
  readonly excludedFromReports?: boolean;
  readonly extraordinary?: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

interface TransactionListRow extends TransactionRow {
  readonly cursorAt: string;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new TypeError(
    `Expected Date instance from database timestamp column, got ${typeof value}`,
  );
}

function classification(row: TransactionRow): Partial<Transaction> {
  // OpenAPI defaults absent flags to false; preserve existing payloads for
  // transactions that have not opted into a classification.
  return {
    ...(row.archived === true ? { archived: true } : {}),
    ...(row.excludedFromReports === true ? { excludedFromReports: true } : {}),
    ...(row.extraordinary === true ? { extraordinary: true } : {}),
  };
}

export class PostgresTransactionAdapter implements LedgerStore, LedgerWriter {
  public static readonly BATCH_SIZE = IMPORT_COMMIT_BATCH_SIZE;

  public async createImportedTransactions(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    commands: readonly ImportedTransactionCommand[],
  ): Promise<void> {
    if (!commands.length) return;
    const batchSize = PostgresTransactionAdapter.BATCH_SIZE;
    for (
      let batchStart = 0;
      batchStart < commands.length;
      batchStart += batchSize
    ) {
      const batch = commands.slice(batchStart, batchStart + batchSize);
      const result = await client.query<{
        id: string;
        account_id: string;
        amount_minor: string;
        currency: string;
        occurred_at: Date;
      }>(
        `insert into public.transactions (workspace_id,account_id,type,status,amount_minor,currency,occurred_at,description,import_job_id,created_by)
           select * from unnest($1::uuid[],$2::uuid[],$3::text[],$4::text[],$5::bigint[],$6::text[],$7::timestamptz[],$8::text[],$9::uuid[],$10::uuid[])
           returning id,account_id,amount_minor,currency,occurred_at`,
        [
          batch.map(() => workspaceId),
          batch.map((command) => command.accountId),
          batch.map(() => 'adjustment'),
          batch.map(() => 'confirmed'),
          batch.map((command) => command.amountMinor),
          batch.map((command) => command.currency),
          batch.map((command) => command.occurredAt),
          batch.map((command) => command.description),
          batch.map((command) => command.importJobId),
          batch.map(() => subject),
        ],
      );
      await client.query(
        `insert into public.ledger_postings (workspace_id,transaction_id,account_id,leg_kind,amount_minor,currency,status,occurred_at)
         select workspace_id,transaction_id,account_id,leg_kind,amount_minor,currency,status,occurred_at
         from unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::text[],$5::bigint[],$6::text[],$7::text[],$8::timestamptz[])
         as input(workspace_id,transaction_id,account_id,leg_kind,amount_minor,currency,status,occurred_at)`,
        [
          result.rows.flatMap(() => [workspaceId, workspaceId]),
          result.rows.flatMap((row) => [row.id, row.id]),
          result.rows.flatMap((row) => [row.account_id, null]),
          result.rows.flatMap(() => ['account', 'external']),
          result.rows.flatMap((row) => [
            row.amount_minor,
            negateAmountMinor(row.amount_minor),
          ]),
          result.rows.flatMap((row) => [row.currency, row.currency]),
          result.rows.flatMap(() => ['confirmed', 'confirmed']),
          result.rows.flatMap((row) => [row.occurred_at, row.occurred_at]),
        ],
      );
    }
  }

  public createImportedTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: ImportedTransactionCommand,
  ): Promise<Transaction> {
    return this.createTransaction(client, workspaceId, subject, {
      type: 'adjustment',
      accountId: command.accountId,
      amount: { amountMinor: command.amountMinor, currency: command.currency },
      occurredAt: command.occurredAt,
      status: 'confirmed',
      description: command.description,
      importJobId: command.importJobId,
    });
  }
  public async createAdjustmentTransaction(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    command: AdjustmentTransactionCommand,
  ): Promise<void> {
    await this.createTransaction(client, workspaceId, subject, {
      type: 'adjustment',
      accountId: command.accountId,
      amount: { amountMinor: command.amountMinor, currency: command.currency },
      occurredAt: command.occurredAt,
      status: 'reconciled',
      description: command.description,
    });
  }
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
    const accountResult = await client.query<{
      status: string;
      currency: string;
    }>(
      'select a.status, a.currency from public.accounts a where a.workspace_id = $1::uuid and a.id = $2::uuid',
      [workspaceId, accountId],
    );
    const accountRow = accountResult.rows[0];
    if (!accountRow) {
      return undefined;
    }
    return { status: accountRow.status, currency: accountRow.currency };
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
    if (command.importJobId) {
      await client.query(
        'update public.transactions set import_job_id=$3::uuid where workspace_id=$1::uuid and id=$2::uuid',
        [workspaceId, row.id, command.importJobId],
      );
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
       t.archived,
       t.excluded_from_reports as "excludedFromReports",
       t.extraordinary,
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
      ...classification(row),
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
       t.archived,
       t.excluded_from_reports as "excludedFromReports",
       t.extraordinary,
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
        ...classification(row),
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
    if (command.extraordinary !== undefined) {
      values.push(command.extraordinary);
      assignments.push(`extraordinary = $${values.length}`);
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
   archived,
   excluded_from_reports as "excludedFromReports",
   extraordinary,
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
      ...classification(row),
      ...(command.extraordinary === undefined
        ? {}
        : { extraordinary: command.extraordinary }),
    };
  }

  public async rescheduleOccurrencePostings(
    client: TransactionClient,
    workspaceId: string,
    booking: { readonly id: string; readonly status: 'draft' | 'pending' },
    occurredAt: string,
  ): Promise<void> {
    // A standalone PATCH may have changed the booking status, not the pair.
    const updated = await client.query(
      `update public.ledger_postings set status = $3, occurred_at = $4::timestamptz
        where workspace_id = $1::uuid and transaction_id = $2::uuid
          and status in ('draft', 'pending', 'confirmed')`,
      [workspaceId, booking.id, booking.status, occurredAt],
    );
    if (updated.rowCount !== 2)
      throw new Error('Occurrence posting pair was not rescheduled.');
    await enforceDeferredConstraints(client);
  }

  public async confirmOccurrencePostings(
    client: TransactionClient,
    workspaceId: string,
    booking: { readonly id: string },
  ): Promise<void> {
    const updated = await client.query(
      `update public.ledger_postings set status = 'confirmed'
        where workspace_id = $1::uuid and transaction_id = $2::uuid
          and status in ('draft', 'pending', 'confirmed')`,
      [workspaceId, booking.id],
    );
    if (updated.rowCount !== 2)
      throw new Error('Occurrence posting pair was not confirmed.');
    await enforceDeferredConstraints(client);
  }

  public async voidTransaction(
    client: TransactionClient,
    workspaceId: string,
    transactionId: string,
    accountId: string,
    postingStatus: string,
    expectedVersions?: number | readonly number[],
    expectedOccurrenceState?: 'draft' | 'pending',
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
   and ${expectedOccurrenceState === undefined ? "status in ('pending', 'confirmed')" : 'status = $4'}
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
   archived,
   excluded_from_reports as "excludedFromReports",
   extraordinary,
   voided_at as "voidedAt",
   import_job_id::text as "importJobId",
   created_at as "createdAt",
   updated_at as "updatedAt",
   version`;

    const result = await client.query<
      TransactionRow & { voidedAt: Date; importJobId: string | null }
    >(sql, [
      workspaceId,
      transactionId,
      versionParam,
      ...(expectedOccurrenceState === undefined
        ? []
        : [expectedOccurrenceState]),
    ]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    if (expectedOccurrenceState !== undefined) {
      // Skip neutralizes the actual pair at its original balance cutoff. A
      // standalone PATCH may have changed the booking but not its postings.
      const compensated = await client.query(
        `insert into public.ledger_postings (
           workspace_id, transaction_id, account_id, leg_kind, amount_minor,
           currency, status, occurred_at
         )
         select workspace_id, transaction_id, account_id, leg_kind, -amount_minor,
                currency, status, occurred_at
           from public.ledger_postings
          where workspace_id = $1::uuid and transaction_id = $2::uuid`,
        [workspaceId, row.id],
      );
      if (compensated.rowCount !== 2)
        throw new Error('Occurrence posting pair was not compensated.');
    } else {
      // Keep the void instant for past postings, but never reverse future
      // postings before they take effect. Linked headers can have a different
      // date from their legs, so use the actual posting cutoff.
      let bookedAmount = String(row.amountMinor);
      if (row.type === 'expense' && row.importJobId) {
        // Conversion normalizes the header but leaves the signed legs intact.
        const booked = await client.query<{ amount: string | null }>(
          `select sum(amount_minor)::text as amount from public.ledger_postings
            where workspace_id = $1::uuid and transaction_id = $2::uuid
              and account_id = $3::uuid and leg_kind = 'account'`,
          [workspaceId, row.id, row.accountId],
        );
        const amount = booked.rows[0]?.amount;
        if (amount == null)
          throw new Error('Imported expense account posting is missing.');
        bookedAmount = amount;
      }
      const postingsSql = `
with reversal_cutoff as (
  select greatest($7::timestamptz, max(p.occurred_at)) as occurred_at
    from public.ledger_postings p
   where p.workspace_id = $1::uuid and p.transaction_id = $2::uuid
)
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
select $1::uuid, $2::uuid, leg.account_id, leg.kind, leg.amount, $5, $6, cutoff.occurred_at
  from (values ($3::uuid, 'account', $4::bigint), (null, 'external', $8::bigint))
    as leg(account_id, kind, amount)
 cross join reversal_cutoff cutoff`;

      const postingsValues = [
        workspaceId,
        row.id,
        row.accountId,
        negateAmountMinor(bookedAmount),
        row.currency,
        postingStatus,
        row.voidedAt,
        bookedAmount,
      ];

      await client.query(postingsSql, postingsValues);
    }

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
      ...classification(row),
    };
  }
}
