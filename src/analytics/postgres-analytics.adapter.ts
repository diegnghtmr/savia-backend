import { buildCategorySpendSql } from '../platform/category-spend-query.js';
import { CURRENCY_RATE_SELECTION_SQL } from '../platform/currency-conversion.js';
import { DEBT_OUTSTANDING_BALANCE_EXPRESSION } from '../platform/debt-balance-query.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  AccountNativeBalanceRow,
  ActiveSubscriptionRow,
  AnalyticsStore,
  BudgetAllocationRow,
  BudgetSpendRow,
  DebtOutstandingBalanceRow,
  SubscriptionPriceRow,
  TransactionFlowRow,
} from './analytics.port.js';

export class PostgresAnalyticsAdapter implements AnalyticsStore {
  /**
   * 6. Authorization: Active role resolution via workspace_actor_active_role.
   */
  public async readActiveRole(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ role: string | null }>(
      'select public.workspace_actor_active_role($1::uuid) as role',
      [workspaceId],
    );
    return result.rows[0]?.role ?? undefined;
  }

  /**
   * 5. Presentation currency: Reads workspace's configured base currency as default.
   */
  public async readWorkspaceBaseCurrency(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<string | undefined> {
    const result = await client.query<{ baseCurrency: string }>(
      'select base_currency as "baseCurrency" from public.workspaces where id = $1::uuid',
      [workspaceId],
    );
    return result.rows[0]?.baseCurrency;
  }

  /**
   * 4.4 assets:
   * Sum of account native balances across the workspace's non-closed accounts.
   * Native balance is derived from ledger_postings filtered by account currency and confirmed/reconciled status.
   */
  public async readAccountNativeBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly AccountNativeBalanceRow[]> {
    const sql = `
select
  acct.id::text as id,
  acct.currency,
  coalesce(
    sum(posting.amount_minor) filter (
      where posting.currency = acct.currency
        and posting.status in ('confirmed', 'reconciled')
    ),
    0
  )::text as "nativeBalanceMinor"
from public.accounts acct
left join public.ledger_postings posting
  on posting.workspace_id = acct.workspace_id
 and posting.account_id = acct.id
where acct.workspace_id = $1::uuid
  and acct.status <> 'closed'
group by acct.id, acct.currency`;

    const result = await client.query<AccountNativeBalanceRow>(sql, [
      workspaceId,
    ]);
    return result.rows;
  }

  /**
   * 4.4 debts:
   * Sum of the outstanding balances of non-archived debts, using the SAME derivation
   * as src/debts/postgres-debt.adapter.ts (principal minus confirmed principal payments, clamped at zero).
   * Extracted to src/platform/debt-balance-query.ts so both callers share identical derivation.
   */
  public async readDebtOutstandingBalances(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly DebtOutstandingBalanceRow[]> {
    const sql = `
select
  d.id::text as id,
  d.currency,
  ${DEBT_OUTSTANDING_BALANCE_EXPRESSION}::text as "outstandingBalanceMinor"
from public.debts d
where d.workspace_id = $1::uuid
  and d.status <> 'archived'`;

    const result = await client.query<DebtOutstandingBalanceRow>(sql, [
      workspaceId,
    ]);
    return result.rows;
  }

  /**
   * 4.1 Period & 4.2 Income and expenses:
   * Period: inclusive on both ends, evaluated in UTC (t.occurred_at at time zone 'utc')::date.
   * Transaction type classification: income, expense, refund.
   * EXCLUDED from both: adjustment, debt_payment, fund_contribution.
   * EXCLUDED entirely: transfers (transfer postings carry a non-null transfer_id; postings checked for transfer_id is null).
   * Pending or voided postings do NOT contribute to any aggregate.
   * expenses is reported as a POSITIVE magnitude even though underlying postings are negative.
   */
  public async readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly TransactionFlowRow[]> {
    const sql = `
select
  t.id::text as id,
  t.type,
  t.amount_minor::text as "amountMinor",
  t.currency,
  t.occurred_at as "occurredAt",
  t.category_id::text as "categoryId",
  c.name as "categoryName"
from public.transactions t
left join public.categories c
  on c.workspace_id = t.workspace_id
 and c.id = t.category_id
where t.workspace_id = $1::uuid
  and t.status in ('confirmed', 'reconciled')
  and exists (
    select 1
    from public.ledger_postings p
    where p.workspace_id = t.workspace_id
      and p.transaction_id = t.id
      and p.status in ('confirmed', 'reconciled')
      and p.transfer_id is null
  )
  and (t.occurred_at at time zone 'utc')::date >= $2::date
  and (t.occurred_at at time zone 'utc')::date <= $3::date
  and t.type in ('income', 'expense', 'refund')`;

    const result = await client.query<TransactionFlowRow>(sql, [
      workspaceId,
      from,
      to,
    ]);
    return result.rows;
  }

  /**
   * §3.1 subscription_price_increases:
   * Reads workspace subscriptions that have a recorded previous amount.
   * Filtered by status in ('detected', 'confirmed').
   * 'ignored' means the user rejected the detection and 'cancelled' means
   * the subscription ended; neither is a live recurring charge.
   */
  public async readSubscriptionsWithPreviousAmount(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly SubscriptionPriceRow[]> {
    const sql = `
select
  id::text as id,
  payee_name as "payeeName",
  current_amount_minor::text as "currentAmountMinor",
  current_currency as "currentCurrency",
  previous_amount_minor::text as "previousAmountMinor",
  previous_currency as "previousCurrency"
from public.subscriptions
where workspace_id = $1::uuid
  and status in ('detected', 'confirmed')
  and previous_amount_minor is not null`;

    const result = await client.query<SubscriptionPriceRow>(sql, [workspaceId]);
    return result.rows;
  }

  /**
   * §3.2 recurring_vs_variable:
   * Reads active workspace subscriptions.
   * Filtered by status in ('detected', 'confirmed').
   * 'ignored' means the user rejected the detection and 'cancelled' means
   * the subscription ended; neither is a live recurring charge.
   */
  public async readActiveSubscriptions(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<readonly ActiveSubscriptionRow[]> {
    const sql = `
select
  current_amount_minor::text as "currentAmountMinor",
  current_currency as "currentCurrency",
  frequency
from public.subscriptions
where workspace_id = $1::uuid
  and status in ('detected', 'confirmed')`;

    const result = await client.query<ActiveSubscriptionRow>(sql, [
      workspaceId,
    ]);
    return result.rows;
  }

  /**
   * 4.5 budgetUtilizationPercent - planned:
   * Across the workspace's budgets whose period overlaps [from, to]:
   * b.period_start <= to::date and b.period_end >= from::date.
   */
  public async readOverlappingBudgetAllocations(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly BudgetAllocationRow[]> {
    const sql = `
select
  budget.currency,
  allocation.planned_minor::text as "plannedMinor"
from public.budget_allocations allocation
join public.budgets budget
  on budget.workspace_id = allocation.workspace_id
 and budget.id = allocation.budget_id
where allocation.workspace_id = $1::uuid
  and budget.period_start <= $3::date
  and budget.period_end >= $2::date`;

    const result = await client.query<BudgetAllocationRow>(sql, [
      workspaceId,
      from,
      to,
    ]);
    return result.rows;
  }

  /**
   * 4.5 budgetUtilizationPercent - actual:
   * Uses EXISTING shared spend derivation buildCategorySpendSql from src/platform/category-spend-query.ts.
   */
  public async readOverlappingBudgetSpend(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<readonly BudgetSpendRow[]> {
    const sql = `
select
  spend."amountMinor",
  spend.currency as "postingCurrency",
  spend."occurredAt"
from public.budget_allocations allocation
join public.budgets budget
  on budget.workspace_id = allocation.workspace_id
 and budget.id = allocation.budget_id
join lateral (${buildCategorySpendSql()}) spend on true
where allocation.workspace_id = $1::uuid
  and budget.period_start <= $3::date
  and budget.period_end >= $2::date
  and spend."amountMinor" is not null`;

    const result = await client.query<BudgetSpendRow>(sql, [
      workspaceId,
      from,
      to,
    ]);
    return result.rows;
  }

  /**
   * 5. Presentation currency:
   * Selects exchange rate using shared CURRENCY_RATE_SELECTION_SQL from src/platform/currency-conversion.ts.
   */
  public async findExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    asOf?: Date | null,
  ): Promise<string | undefined> {
    const result = await client.query<{ rate: string }>(
      CURRENCY_RATE_SELECTION_SQL,
      [workspaceId, baseCurrency, quoteCurrency, asOf ?? null],
    );
    return result.rows[0]?.rate;
  }
}
