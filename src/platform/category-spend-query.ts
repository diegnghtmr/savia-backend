export const CATEGORY_SPEND_EXPRESSION = `coalesce(sum(posting.amount_minor) filter (where posting.currency = budget.currency and posting.status in ('confirmed', 'reconciled')), 0)::text as actual`;

export const CATEGORY_FOREIGN_CURRENCY_LEGS_EXPRESSION = `count(*) filter (where posting.currency <> budget.currency)::text as "foreignCurrencyLegs"`;

export const CATEGORY_SPEND_FROM_WHERE_CLAUSE = `
  from public.ledger_postings posting
  join public.transactions transaction
    on transaction.workspace_id = posting.workspace_id
   and transaction.id = posting.transaction_id
  where posting.workspace_id = allocation.workspace_id
    and transaction.category_id = allocation.category_id
    and posting.account_id is not null
    and posting.occurred_at::date between budget.period_start and budget.period_end
`;

export function buildCategorySpendSql(): string {
  return `select
  ${CATEGORY_SPEND_EXPRESSION},
  ${CATEGORY_FOREIGN_CURRENCY_LEGS_EXPRESSION}
  ${CATEGORY_SPEND_FROM_WHERE_CLAUSE}`;
}
