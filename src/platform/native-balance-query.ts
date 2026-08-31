export const NATIVE_BALANCE_EXPRESSION = `coalesce(sum(posting.amount_minor) filter (where posting.currency = acct.currency and posting.status in ('confirmed', 'reconciled')), 0)::text as "nativeBalance"`;

export const FOREIGN_CURRENCY_LEGS_EXPRESSION = `count(*) filter (where posting.currency <> acct.currency)::text as "foreignCurrencyLegs"`;

export const BALANCE_FROM_WHERE_CLAUSE = `
  from public.ledger_postings posting
  join public.accounts acct
    on acct.id = posting.account_id
   and acct.workspace_id = posting.workspace_id
 where posting.workspace_id = $1::uuid
   and posting.account_id = $2::uuid
   and posting.occurred_at <= coalesce($3::timestamptz, now())
`;

export function buildNativeBalanceSql(
  extraSelections: readonly string[] = [],
): string {
  const selections = [
    NATIVE_BALANCE_EXPRESSION,
    ...extraSelections,
    FOREIGN_CURRENCY_LEGS_EXPRESSION,
  ];
  return `select\n  ${selections.join(',\n  ')}\n  ${BALANCE_FROM_WHERE_CLAUSE}`;
}
