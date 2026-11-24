import { buildCategorySpendSql } from '../platform/category-spend-query.js';
import {
  ANALYTICS_CURRENCY_RATE_SELECTION_SQL,
  HISTORICAL_CURRENCY_RATE_SELECTION_SQL,
  type SelectedFxRate,
} from '../platform/currency-conversion.js';
import type { TransactionClient } from '../platform/pg-transaction.js';
import type {
  AccountNativeBalanceRow,
  ActiveSubscriptionRow,
  AnalyticsFilters,
  AnalyticsStore,
  BudgetAllocationRow,
  BudgetSpendRow,
  DebtOutstandingBalanceRow,
  DebtPaymentCostRow,
  DebtTermsRow,
  HistoricPositionRow,
  ScheduledOutflowRow,
  SubscriptionPriceRow,
  TransactionFlowRow,
} from './analytics.port.js';

function filterValues(filters?: AnalyticsFilters) {
  return [
    filters?.accountIds ?? null,
    filters?.categoryIds ?? null,
    filters?.tagIds ?? null,
    filters?.payeeIds ?? null,
    filters?.memberIds ?? null,
  ];
}

// Member filters use the public roster's membership IDs, not profile IDs. The
// roster also resolves peers for a viewer, without widening membership RLS.
const transactionFiltersSql = `
  and ($4::uuid[] is null or t.account_id = any($4))
  and ($5::uuid[] is null or t.category_id = any($5))
  and ($6::uuid[] is null or t.tag_ids && $6)
  and ($7::uuid[] is null or t.payee_id = any($7))
  and ($8::uuid[] is null or exists (
    select 1 from public.workspace_member_roster($1) m
     where m.membership_id = any($8) and m.profile_id = t.created_by
  ))`;

const bookingPredicates = `
  and not t.excluded_from_reports
  and t.status in ('confirmed', 'reconciled')
  and exists (
    select 1 from public.ledger_postings p
     where p.workspace_id = t.workspace_id and p.transaction_id = t.id
       and p.status in ('confirmed', 'reconciled') and p.transfer_id is null
  )
  and not exists (
    select 1 from public.ledger_postings p
     where p.workspace_id = t.workspace_id and p.transaction_id = t.id
       and p.status not in ('confirmed', 'reconciled')
  )
  and t.occurred_at >= $2::date::timestamp at time zone 'UTC'
  and t.occurred_at < ($3::date + 1)::timestamp at time zone 'UTC'`;

const subscriptionFacts = `
from public.subscriptions s
left join public.transactions t on t.workspace_id = s.workspace_id
 and t.id = (to_jsonb(s)->>'detection_observation_id')::uuid
where s.workspace_id = $1::uuid and s.status in ('detected', 'confirmed')
  and not coalesce(t.excluded_from_reports, false)`;

// A void after the cut does not erase a posted payment from the earlier cut.
// Exclusion is a reporting filter, not a mutation of the debt or its postings.
function debtBalanceAt(cut: string): string {
  return `greatest(0, d.principal_minor - coalesce((
    select sum(dp.principal_minor)
    from public.debt_payments dp
    join public.transactions t on t.workspace_id = dp.workspace_id and t.id = dp.transaction_id
    where dp.workspace_id = d.workspace_id and dp.debt_id = d.id
      and not t.excluded_from_reports and t.occurred_at < ${cut}
      and (t.status in ('confirmed', 'reconciled') or t.voided_at >= ${cut})
      and exists (select 1 from public.ledger_postings p
        where p.workspace_id = t.workspace_id and p.transaction_id = t.id
          and p.account_id is not null and p.currency = d.currency
          and p.status in ('confirmed', 'reconciled') and p.occurred_at < ${cut})
  ), 0))`;
}

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
    accountIds?: readonly string[],
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
 and not exists (
   select 1 from public.transactions t
    where t.workspace_id = posting.workspace_id and t.id = posting.transaction_id
      and t.excluded_from_reports
 )
where acct.workspace_id = $1::uuid
  and acct.status <> 'closed'
  and ($2::uuid[] is null or acct.id = any($2))
group by acct.id, acct.currency`;

    const result = await client.query<AccountNativeBalanceRow>(sql, [
      workspaceId,
      accountIds ?? null,
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
  ${debtBalanceAt("'infinity'::timestamptz")}::text as "outstandingBalanceMinor"
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
   * Posting status enforcement: at least one posting confirmed or reconciled,
   * and no posting outside that set (not exists non-confirmed/non-reconciled).
   * Note: mixed posting statuses are currently unreachable through any application write path
   * because both legs are created and updated atomically; this pair of predicates is defence
   * in depth, not a live bug fix.
   * expenses is reported as a POSITIVE magnitude even though underlying postings are negative.
   */
  public async readTransactionsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    filters?: AnalyticsFilters,
    includeOtherBookings = false,
    classifyRecurring = false,
  ): Promise<readonly TransactionFlowRow[]> {
    const recurring =
      classifyRecurring && (await this.hasRecurringHistory(client))
        ? `exists (select 1 from public.recurring_occurrences o
          where o.workspace_id = t.workspace_id and o.transaction_id = t.id)`
        : 'false';
    const detected = classifyRecurring
      ? `exists (select 1 from public.subscriptions s
      where s.workspace_id = t.workspace_id and s.status in ('detected', 'confirmed')
        and (to_jsonb(s)->>'detection_observation_id')::uuid = t.id)`
      : 'false';
    const sql = `
select
  t.id::text as id,
  t.type,
  t.amount_minor::text as "amountMinor",
  t.currency,
  t.occurred_at as "occurredAt",
  t.category_id::text as "categoryId",
  c.name as "categoryName",
  t.payee_id::text as "payeeId",
  t.description,
  coalesce(c.essential, false) as essential,
  t.extraordinary,
  (${recurring} or ${detected}) as recurrent
from public.transactions t
left join public.categories c
  on c.workspace_id = t.workspace_id
 and c.id = t.category_id
where t.workspace_id = $1::uuid
  ${bookingPredicates}
  and t.type in ('income', 'expense', 'refund'${includeOtherBookings ? ", 'debt_payment', 'fund_contribution', 'adjustment'" : ''})
  ${transactionFiltersSql}
order by t.occurred_at, t.id`;

    const result = await client.query<TransactionFlowRow>(sql, [
      workspaceId,
      from,
      to,
      ...filterValues(filters),
    ]);
    return result.rows;
  }

  public async hasRecurringHistory(
    client: TransactionClient,
  ): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(`select coalesce(
      has_table_privilege(current_user, to_regclass('public.recurring_occurrences'), 'SELECT'), false
    ) as available`);
    return result.rows[0]?.available ?? false;
  }

  public async readHistoricPositions(
    client: TransactionClient,
    workspaceId: string,
    dates: readonly string[],
    asOf: Date,
    accountIds?: readonly string[],
  ): Promise<readonly HistoricPositionRow[]> {
    const result = await client.query<HistoricPositionRow>(
      `
with cuts as (
  select day, least((day + 1)::timestamp at time zone 'UTC', $4::timestamptz + interval '1 microsecond') as cutoff
  from unnest($2::date[]) as days(day)
)
select cuts.day::text as date, a.currency, 'account' as kind,
       coalesce(sum(p.amount_minor), 0)::text as "amountMinor"
from cuts
join public.accounts a on a.workspace_id = $1::uuid and a.created_at < cuts.cutoff
 and (a.closed_at is null or a.closed_at >= cuts.cutoff) and a.include_in_net_worth
left join public.ledger_postings p on p.workspace_id = a.workspace_id and p.account_id = a.id
 and p.currency = a.currency and p.status in ('confirmed', 'reconciled') and p.occurred_at < cuts.cutoff
 and not exists (select 1 from public.transactions t
   where t.workspace_id = p.workspace_id and t.id = p.transaction_id and t.excluded_from_reports)
where $3::uuid[] is null or a.id = any($3)
group by cuts.day, a.id, a.currency
union all
select cuts.day::text, d.currency, 'debt', ${debtBalanceAt('cuts.cutoff')}::text
from cuts
join public.debts d on d.workspace_id = $1::uuid and d.created_at < cuts.cutoff
 and (d.start_date is null or d.start_date <= cuts.day)
where $3::uuid[] is null`,
      [workspaceId, dates, accountIds ?? null, asOf],
    );
    return result.rows;
  }

  public async readDebtTerms(
    client: TransactionClient,
    workspaceId: string,
    asOf: Date,
  ): Promise<readonly DebtTermsRow[]> {
    const result = await client.query<DebtTermsRow>(
      `
select d.id::text, d.currency, d.annual_rate::text as "annualRate", d.rate_type as "rateType",
       d.minimum_payment_minor::text as "minimumPaymentMinor", to_jsonb(d)->>'payment_frequency' as frequency,
       ${debtBalanceAt('$2::timestamptz')}::text as "outstandingBalanceMinor"
from public.debts d where d.workspace_id = $1::uuid and d.status = 'active'
 and d.created_at < $2::timestamptz and (d.start_date is null or d.start_date <= ($2 at time zone 'UTC')::date)
order by d.id`,
      [workspaceId, asOf],
    );
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
    filters?: AnalyticsFilters,
  ): Promise<readonly SubscriptionPriceRow[]> {
    const rows = await this.readActiveSubscriptions(
      client,
      workspaceId,
      filters,
    );
    return rows.flatMap((row) =>
      row.id &&
      row.payeeName &&
      row.previousAmountMinor != null &&
      row.previousCurrency
        ? [
            {
              id: row.id,
              payeeName: row.payeeName,
              currentAmountMinor: row.currentAmountMinor,
              currentCurrency: row.currentCurrency,
              previousAmountMinor: row.previousAmountMinor,
              previousCurrency: row.previousCurrency,
            },
          ]
        : [],
    );
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
    filters?: AnalyticsFilters,
  ): Promise<readonly ActiveSubscriptionRow[]> {
    const sql = `
select s.id::text, s.payee_name as "payeeName", s.current_amount_minor::text as "currentAmountMinor",
  s.current_currency as "currentCurrency", s.previous_amount_minor::text as "previousAmountMinor",
  s.previous_currency as "previousCurrency", s.frequency,
  (s.next_expected_at at time zone 'UTC')::date::text as "nextExpectedDate",
  to_jsonb(s)->>'recurring_rule_id' as "recurringRuleId", t.id::text as "observationId"
${subscriptionFacts}
${transactionFiltersSql}
  and $2::date is null and $3::date is null`;

    const result = await client.query<ActiveSubscriptionRow>(sql, [
      workspaceId,
      null,
      null,
      ...filterValues(filters),
    ]);
    return result.rows;
  }

  /**
   * §3.3 debt_cost_evolution:
   * Reads debt payment costs (interest and fees) within the period.
   *
   * Predicate invariants:
   * Both the transaction status AND the posting-status predicates are required:
   * at least one posting confirmed or reconciled, and no posting outside that set.
   * Note: mixed posting statuses are currently unreachable through any application write path
   * because both legs are created and updated atomically; this pair of predicates is defence
   * in depth, not a live bug fix.
   */
  public async readDebtPaymentCostsInPeriod(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    filters?: AnalyticsFilters,
  ): Promise<readonly DebtPaymentCostRow[]> {
    const sql = `
select
  dp.principal_minor::text as "principalPaidMinor",
  dp.interest_minor::text as "interestMinor",
  dp.fee_minor::text as "feeMinor",
  d.currency,
  t.occurred_at as "occurredAt"
from public.debt_payments dp
join public.debts d
  on d.workspace_id = dp.workspace_id and d.id = dp.debt_id
join public.transactions t
  on t.workspace_id = dp.workspace_id and t.id = dp.transaction_id
where dp.workspace_id = $1::uuid
  ${bookingPredicates}
  ${transactionFiltersSql}`;

    const result = await client.query<DebtPaymentCostRow>(sql, [
      workspaceId,
      from,
      to,
      ...filterValues(filters),
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
join lateral (${buildCategorySpendSql()} and not transaction.excluded_from_reports) spend on true
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
   * Returns the exact selected rate and its provenance at selection time.
   */
  public async findExchangeRate(
    client: TransactionClient,
    workspaceId: string,
    baseCurrency: string,
    quoteCurrency: string,
    asOf?: Date | null,
    historical = false,
  ): Promise<SelectedFxRate | undefined> {
    const result = await client.query<SelectedFxRate & Record<string, unknown>>(
      historical
        ? HISTORICAL_CURRENCY_RATE_SELECTION_SQL
        : ANALYTICS_CURRENCY_RATE_SELECTION_SQL,
      [workspaceId, baseCurrency, quoteCurrency, asOf ?? null],
    );
    return result.rows[0];
  }

  /**
   * §3.1 financial_calendar - scheduled outflows:
   * Reads forward-scheduled outflow facts inside [from, to] evaluated in UTC.
   *
   * Single query with three UNION ALL branches, each labelled by a kind column:
   * 1. Subscriptions: active charges ('detected', 'confirmed') by next_expected_at.
   *    Evaluated in UTC: (next_expected_at at time zone 'utc')::date.
   * 2. Debts: active debt minimum payments.
   *    Unlike subscriptions and recurring rules, debts.next_payment_at is already
   *    typed as a SQL 'date' in public.debts (calendar date without time/timezone),
   *    so it requires no timezone conversion and compares directly to $2::date / $3::date.
   * 3. Recurring rules: active transaction automation rules by next_occurrence_at.
   *    Evaluated in UTC: (next_occurrence_at at time zone 'utc')::date.
   *    Filters rules where ends_at is null or (ends_at at time zone 'utc')::date >= $2::date.
   */
  public async readScheduledOutflows(
    client: TransactionClient,
    workspaceId: string,
    from: string,
    to: string,
    filters?: AnalyticsFilters,
  ): Promise<readonly ScheduledOutflowRow[]> {
    const sql = `
select
  case when d.term_months is not null then 'installment' else 'debt_payment' end as kind,
  d.id::text as "refId",
  d.name as label,
  d.minimum_payment_minor::text as "amountMinor",
  d.currency as currency,
  d.next_payment_at::text as "scheduledDate",
  null::jsonb as template
from public.debts d
where d.workspace_id = $1::uuid
  and d.status = 'active'
  and d.minimum_payment_minor is not null
  and d.next_payment_at is not null
  and d.next_payment_at >= $2::date
  and d.next_payment_at <= $3::date
  and coalesce($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[]) is null

union all

select
  case when r.behavior = 'remind' then 'reminder' else 'recurring_rule' end as kind,
  r.id::text as "refId",
  r.name as label,
  (r.template->'amount'->>'amountMinor') as "amountMinor",
  (r.template->'amount'->>'currency') as currency,
  (r.next_occurrence_at at time zone 'utc')::date::text as "scheduledDate",
  r.template as template
from public.recurring_rules r
where r.workspace_id = $1::uuid
  and r.active = true
  and r.next_occurrence_at >= r.starts_at
  and (r.ends_at is null or r.next_occurrence_at <= r.ends_at)
  and (r.next_occurrence_at at time zone 'utc')::date between $2::date and $3::date
  and ($4::uuid[] is null or r.account_id = any($4))
  and ($5::uuid[] is null or r.template->>'categoryId' = any($5::text[]))
  and ($6::uuid[] is null or (r.template->'tagIds') ?| $6::text[])
  and ($7::uuid[] is null or r.template->>'payeeId' = any($7::text[]))
  and ($8::uuid[] is null or exists (select 1 from public.workspace_member_roster($1) m
    where m.membership_id = any($8) and m.profile_id = r.created_by))`;

    const result = await client.query<ScheduledOutflowRow>(sql, [
      workspaceId,
      from,
      to,
      ...filterValues(filters),
    ]);
    const subscriptions = await this.readActiveSubscriptions(
      client,
      workspaceId,
      filters,
    );
    const scheduledSubs: ScheduledOutflowRow[] = [];
    for (const row of subscriptions) {
      const date = row.nextExpectedDate;
      if (
        !date ||
        date < from ||
        date > to ||
        !row.id ||
        !row.payeeName ||
        row.recurringRuleId
      )
        continue;
      scheduledSubs.push({
        kind: 'subscription',
        refId: row.id,
        label: row.payeeName,
        amountMinor: row.currentAmountMinor,
        currency: row.currentCurrency,
        scheduledDate: date,
      });
    }
    return [...result.rows, ...scheduledSubs];
  }

  /**
   * §3.1 financial_calendar - debts without scheduled amount:
   * Counts active workspace debts whose minimum_payment_minor is null.
   * Queried separately rather than contorting the scheduled outflows union query.
   */
  public async readActiveDebtsWithoutScheduledAmount(
    client: TransactionClient,
    workspaceId: string,
  ): Promise<number> {
    const sql = `
select count(*)::text as count
from public.debts d
where d.workspace_id = $1::uuid
  and d.status = 'active'
  and d.minimum_payment_minor is null`;

    const result = await client.query<{ count: string }>(sql, [workspaceId]);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }
}
