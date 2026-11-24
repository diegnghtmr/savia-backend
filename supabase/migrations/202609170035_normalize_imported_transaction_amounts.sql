begin;

create or replace function public.guard_imported_transaction_conversion() returns trigger
language plpgsql set search_path = pg_catalog
as $$
begin
  if not (
    old.type = 'adjustment' and old.import_job_id is not null
    and new.import_job_id is not distinct from old.import_job_id
    and old.status not in ('reconciled', 'voided')
    and new.status = old.status and new.occurred_at = old.occurred_at
    and ((new.type = 'income' and old.amount_minor > 0)
      or (new.type = 'expense' and old.amount_minor < 0))
  ) then
    raise exception 'Only imported adjustments with a compatible amount may be converted.'
      using errcode = 'check_violation';
  end if;

  -- Income and expense headers store a magnitude. Keep the signed ledger
  -- legs as booked and do not grant a direct update on amount_minor.
  new.amount_minor := abs(old.amount_minor);
  return new;
end;
$$;

commit;
