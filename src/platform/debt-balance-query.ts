export function buildDebtOutstandingBalanceSql(
  debtTableAlias: string = 'd',
): string {
  return `greatest(
    0,
    ${debtTableAlias}.principal_minor - coalesce(
      (
        select sum(dp.principal_minor)
        from public.debt_payments dp
        join public.ledger_postings p
          on p.workspace_id = dp.workspace_id
         and p.transaction_id = dp.transaction_id
        where dp.workspace_id = ${debtTableAlias}.workspace_id
          and dp.debt_id = ${debtTableAlias}.id
          and p.account_id is not null
          and p.currency = ${debtTableAlias}.currency
          and p.status in ('confirmed', 'reconciled')
      ),
      0
    )
  )`;
}

export const DEBT_OUTSTANDING_BALANCE_EXPRESSION =
  buildDebtOutstandingBalanceSql('d');
