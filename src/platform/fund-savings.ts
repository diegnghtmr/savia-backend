import type { TransactionClient } from './pg-transaction.js';

const transactionJoin = `join public.transactions t
  on t.workspace_id = fc.workspace_id and t.id = fc.transaction_id`;

// For the fund cutoff only, use the original leg's date for its reversal.
// The stored date remains the void instant used by account balances.
const effectiveDateFilter = `and (case
  when t.voided_at is not null and p.account_id = t.account_id
    and p.amount_minor::numeric = -t.amount_minor::numeric
  then coalesce((
    select min(original.occurred_at)
    from public.ledger_postings original
    where original.workspace_id = p.workspace_id
      and original.transaction_id = p.transaction_id
      and original.account_id = p.account_id
      and original.currency = p.currency
      and original.amount_minor = t.amount_minor
  ), p.occurred_at)
  else p.occurred_at
end) <= statement_timestamp()`;

// The signed account leg represents either direction of fund movement. Legacy
// list/create reads include future postings; effective reads use a cutoff.
export function fundSavedAmountSql(effective = false): string {
  return `coalesce((
    select -sum(p.amount_minor)
    from public.fund_contributions fc
    join public.ledger_postings p
      on p.workspace_id = fc.workspace_id and p.transaction_id = fc.transaction_id
    ${effective ? transactionJoin : ''}
    where fc.workspace_id = f.workspace_id and fc.fund_id = f.id
      and p.account_id is not null and p.currency = f.currency
      and p.status in ('confirmed', 'reconciled')
      ${effective ? effectiveDateFilter : ''}
  ), 0)::text`;
}

// Fund writers acquire this after the subject lock and before any account lock.
export async function lockFund(
  client: TransactionClient,
  workspaceId: string,
  fundId: string,
): Promise<void> {
  const sql = 'select pg_advisory_xact_lock(hashtextextended($1, 0))';
  const key = `fund:${workspaceId.toLowerCase()}:${fundId.toLowerCase()}`;
  await client.query(sql, [key]);
}
