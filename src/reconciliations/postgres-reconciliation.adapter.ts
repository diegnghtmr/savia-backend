import type { TransactionClient } from '../platform/pg-transaction.js';
import { buildNativeBalanceSql } from '../platform/native-balance-query.js';
import {
  AmountOutOfRangeError,
  OpenReconciliationExistsError,
  ReconciliationAccountNotFoundError,
  ReconciliationCompletionRollbackError,
  type Reconciliation,
  type ReconciliationStatus,
  type ReconciliationStore,
  type ReconciliationStoreAccount,
  type ReconciliationStoreBalance,
  type ReconciliationStoreInsertData,
} from './reconciliation.port.js';

interface ReconciliationRow extends Record<string, unknown> {
  readonly id: string;
  readonly accountId: string;
  readonly statementDate: string;
  readonly statementBalanceMinor: string;
  readonly statementCurrency: string;
  readonly systemBalanceMinor: string;
  readonly differenceMinor: string;
  readonly status: ReconciliationStatus;
  readonly completedAt: Date | string | null;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return value;
  }
  return '';
}

function mapRowToReconciliation(row: ReconciliationRow): Reconciliation {
  return {
    id: row.id,
    accountId: row.accountId,
    statementDate: row.statementDate,
    statementBalance: {
      amountMinor: row.statementBalanceMinor,
      currency: row.statementCurrency,
    },
    systemBalance: {
      amountMinor: row.systemBalanceMinor,
      currency: row.statementCurrency,
    },
    difference: {
      amountMinor: row.differenceMinor,
      currency: row.statementCurrency,
    },
    status: row.status,
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
  };
}

export class PostgresReconciliationAdapter implements ReconciliationStore {
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

  public async readAccount(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
  ): Promise<ReconciliationStoreAccount | undefined> {
    // 1. Mandatory per-account advisory lock (serialized against closeAccount)
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [accountId.toLowerCase()],
    );

    const sql = `
      select id::text,
             currency,
             status
        from public.accounts
       where workspace_id = $1::uuid
         and id = $2::uuid
       limit 1
    `;
    const result = await client.query<{
      id: string;
      currency: string;
      status: string;
    }>(sql, [workspaceId, accountId]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      currency: row.currency,
      status: row.status,
    };
  }

  public async readAccountBalance(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    asOf?: string,
  ): Promise<ReconciliationStoreBalance | undefined> {
    const balanceSql = buildNativeBalanceSql();
    let balanceResult: {
      rows: { nativeBalance: string; foreignCurrencyLegs: string }[];
    };
    try {
      balanceResult = await client.query<{
        nativeBalance: string;
        foreignCurrencyLegs: string;
      }>(balanceSql, [workspaceId, accountId, asOf ?? null]);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '22003'
      ) {
        throw new AmountOutOfRangeError();
      }
      throw error;
    }
    const balanceRow = balanceResult.rows[0];
    if (!balanceRow) {
      return undefined;
    }

    if (balanceRow.foreignCurrencyLegs !== '0') {
      throw new Error(
        'Cannot report single-currency balance for an account holding postings in another currency.',
      );
    }

    const acctRes = await client.query<{ currency: string }>(
      'select currency from public.accounts where workspace_id = $1::uuid and id = $2::uuid',
      [workspaceId, accountId],
    );
    const acctRow = acctRes.rows[0];
    if (!acctRow) {
      return undefined;
    }

    return {
      nativeBalance: {
        amountMinor: balanceRow.nativeBalance,
        currency: acctRow.currency,
      },
    };
  }

  public async createReconciliation(
    client: TransactionClient,
    workspaceId: string,
    subject: string,
    data: ReconciliationStoreInsertData,
  ): Promise<Reconciliation> {
    const sql = `
      insert into public.reconciliations (
        workspace_id,
        account_id,
        statement_date,
        statement_balance_minor,
        statement_currency,
        system_balance_minor,
        difference_minor,
        status,
        notes,
        created_by
      ) values (
        $1::uuid,
        $2::uuid,
        $3::date,
        $4::bigint,
        $5,
        $6::bigint,
        $7::bigint,
        $8,
        $9,
        $10::uuid
      )
      returning
        id::text,
        account_id::text as "accountId",
        to_char(statement_date, 'YYYY-MM-DD') as "statementDate",
        statement_balance_minor::text as "statementBalanceMinor",
        statement_currency as "statementCurrency",
        system_balance_minor::text as "systemBalanceMinor",
        difference_minor::text as "differenceMinor",
        status,
        completed_at as "completedAt"
    `;

    const values = [
      workspaceId,
      data.accountId,
      data.statementDate,
      data.statementBalance.amountMinor,
      data.statementBalance.currency,
      data.systemBalance.amountMinor,
      data.difference.amountMinor,
      data.status,
      data.notes ?? null,
      subject,
    ];

    try {
      const result = await client.query<ReconciliationRow>(sql, values);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Created reconciliation row could not be read.');
      }
      return mapRowToReconciliation(row);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const pgError = error as { code: string; constraint?: string };
        if (
          pgError.code === '23505' &&
          pgError.constraint === 'reconciliations_one_open_per_account_idx'
        ) {
          throw new OpenReconciliationExistsError();
        }
        if (
          pgError.code === '23503' &&
          pgError.constraint === 'reconciliations_account_workspace_fkey'
        ) {
          throw new ReconciliationAccountNotFoundError();
        }
        if (pgError.code === '22003') {
          throw new AmountOutOfRangeError();
        }
      }
      throw error;
    }
  }

  public async findReconciliationById(
    client: TransactionClient,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<Reconciliation | undefined> {
    const sql = `
      select id::text,
             account_id::text as "accountId",
             to_char(statement_date, 'YYYY-MM-DD') as "statementDate",
             statement_balance_minor::text as "statementBalanceMinor",
             statement_currency as "statementCurrency",
             system_balance_minor::text as "systemBalanceMinor",
             difference_minor::text as "differenceMinor",
             status,
             completed_at as "completedAt"
        from public.reconciliations
       where workspace_id = $1::uuid
         and id = $2::uuid
       limit 1
    `;
    const result = await client.query<ReconciliationRow>(sql, [
      workspaceId,
      reconciliationId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return mapRowToReconciliation(row);
  }

  public async lockAndReadCompletion(
    client: TransactionClient,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<Reconciliation | undefined> {
    const initial = await this.findReconciliationById(
      client,
      workspaceId,
      reconciliationId,
    );
    if (!initial) return undefined;
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [initial.accountId.toLowerCase()],
    );
    const account = await client.query<{ status: string }>(
      'select status from public.accounts where workspace_id = $1::uuid and id = $2::uuid',
      [workspaceId, initial.accountId],
    );
    if (!account.rows[0] || account.rows[0].status === 'closed') {
      throw new ReconciliationCompletionRollbackError('transactions-invalid');
    }
    return this.findReconciliationById(client, workspaceId, reconciliationId);
  }

  public async validateCompletionTransactions(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    transactionIds: readonly string[],
    statementDate: string,
  ): Promise<
    | 'valid'
    | 'not-found'
    | 'no-posting'
    | 'wrong-status'
    | 'already-reconciled'
    | 'after-cutoff'
  > {
    if (transactionIds.length === 0) return 'valid';
    await client.query(
      `select id from public.ledger_postings where workspace_id = $1::uuid and transaction_id = any($2::uuid[]) and account_id = $3::uuid for update`,
      [workspaceId, transactionIds, accountId],
    );
    const result = await client.query<{
      id: string;
      status: string;
      occurredAt: Date;
      accountPostingCount: string;
      confirmedPostingCount: string;
      reconciledPostingCount: string;
    }>(
      `
      with locked_transactions as materialized (
        select t.id, t.status, t.occurred_at
          from public.transactions t
         where t.workspace_id = $1::uuid and t.id = any($2::uuid[])
         for update
      )
      select t.id::text, t.status, t.occurred_at as "occurredAt",
             count(lp.id) filter (where lp.account_id = $3::uuid)::text as "accountPostingCount",
             count(lp.id) filter (where lp.account_id = $3::uuid and lp.status = 'confirmed')::text as "confirmedPostingCount",
             count(lp.id) filter (where lp.account_id = $3::uuid and lp.status = 'reconciled')::text as "reconciledPostingCount"
        from locked_transactions t
        left join public.ledger_postings lp on lp.workspace_id = t.workspace_id and lp.transaction_id = t.id
       where t.workspace_id = $1::uuid and t.id = any($2::uuid[])
       group by t.id`,
      [workspaceId, transactionIds, accountId],
    );
    if (result.rows.length !== transactionIds.length) return 'not-found';
    const cutoff = `${statementDate}T23:59:59.999999Z`;
    for (const row of result.rows) {
      if (row.accountPostingCount === '0') return 'no-posting';
      if (row.accountPostingCount !== row.confirmedPostingCount)
        return 'wrong-status';
      if (row.status === 'reconciled' || row.reconciledPostingCount !== '0')
        return 'already-reconciled';
      if (row.status !== 'confirmed') return 'wrong-status';
      if (row.occurredAt > new Date(cutoff)) return 'after-cutoff';
    }
    return 'valid';
  }

  public async reconcileTransactions(
    client: TransactionClient,
    workspaceId: string,
    accountId: string,
    transactionIds: readonly string[],
  ): Promise<void> {
    if (transactionIds.length === 0) return;
    const transactionResult = await client.query(
      `update public.transactions set status = 'reconciled' where workspace_id = $1::uuid and id = any($2::uuid[]) and status = 'confirmed'`,
      [workspaceId, transactionIds],
    );
    if ((transactionResult.rowCount ?? 0) !== transactionIds.length)
      throw new ReconciliationCompletionRollbackError('transactions-invalid');
    const postingResult = await client.query(
      `update public.ledger_postings set status = 'reconciled' where workspace_id = $1::uuid and transaction_id = any($2::uuid[]) and account_id = $3::uuid and status = 'confirmed'`,
      [workspaceId, transactionIds, accountId],
    );
    if ((postingResult.rowCount ?? 0) !== transactionIds.length)
      throw new ReconciliationCompletionRollbackError('transactions-invalid');
  }

  public async completeReconciliation(
    client: TransactionClient,
    workspaceId: string,
    reconciliationId: string,
  ): Promise<Reconciliation | undefined> {
    const result = await client.query<ReconciliationRow>(
      `
      update public.reconciliations set status = 'completed', completed_at = now()
       where workspace_id = $1::uuid and id = $2::uuid and status = 'open'
       returning id::text, account_id::text as "accountId", to_char(statement_date, 'YYYY-MM-DD') as "statementDate",
       statement_balance_minor::text as "statementBalanceMinor", statement_currency as "statementCurrency",
       system_balance_minor::text as "systemBalanceMinor", difference_minor::text as "differenceMinor", status, completed_at as "completedAt"`,
      [workspaceId, reconciliationId],
    );
    const row = result.rows[0];
    return row ? mapRowToReconciliation(row) : undefined;
  }
}
