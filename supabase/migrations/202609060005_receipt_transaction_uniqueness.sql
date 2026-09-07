begin;

-- Refuse to install over duplicate receipt links. Operators must reconcile this
-- data before the database can become the authority for the invariant.
do $$
begin
  if exists (
    select workspace_id, receipt_id
    from public.transactions
    where receipt_id is not null
    group by workspace_id, receipt_id
    having count(*) > 1
  ) then
    raise exception 'existing transactions contain duplicate receipt links';
  end if;
end;
$$;

create unique index receipts_one_transaction_per_receipt
  on public.transactions (workspace_id, receipt_id)
  where receipt_id is not null;

commit;
