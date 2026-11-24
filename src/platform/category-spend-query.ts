// A converted imported expense has a positive header but was booked as a
// debit. Flip that booking's spend direction, including any later reversal;
// taking ABS on each leg would turn a reversal into additional spending.
export const CATEGORY_SPEND_EXPRESSION = `(case
    when transaction.type = 'expense' and transaction.import_job_id is not null
      and transaction.amount_minor > 0 then -posting.amount_minor::numeric
    else posting.amount_minor
  end)::text as "amountMinor", posting.currency, posting.occurred_at as "occurredAt"`;

export const CATEGORY_SPEND_FROM_WHERE_CLAUSE = `
  from public.ledger_postings posting
  join public.transactions transaction
    on transaction.workspace_id = posting.workspace_id
   and transaction.id = posting.transaction_id
  where posting.workspace_id = allocation.workspace_id
    and transaction.category_id = allocation.category_id
    and posting.account_id is not null
    and posting.occurred_at::date between budget.period_start and budget.period_end
    and posting.status in ('confirmed', 'reconciled')
`;

export function buildCategorySpendSql(reportOnly = false): string {
  return `select
  ${CATEGORY_SPEND_EXPRESSION}
  ${CATEGORY_SPEND_FROM_WHERE_CLAUSE}${reportOnly ? '    and not transaction.excluded_from_reports\n' : ''}`;
}
